import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  operationSchema,
  applicationSpecSchema,
  deploymentStates,
  type AgentOperation,
} from "../../../packages/application-spec/src/index.js";
import { agentRequest } from "../../../packages/shared/src/index.js";
import {
  audit,
  domainRecords,
  recordServices,
  enqueue,
  projectLock,
  json,
} from "./projects.js";
export type AgentClient = (op: AgentOperation) => Promise<unknown>;
export function agentClient(socket: string, token: string): AgentClient {
  return (op) => agentRequest(socket, op, token);
}
interface Payload {
  spec: unknown;
  encryptedSecrets?: string;
  revision: number;
  previousDesiredState: string;
  rollbackOf?: string;
  maintenanceEnabled?: boolean;
}
interface AgentStatus {
  status: string;
  progress: number;
  phase: string;
  result?: unknown;
  error?: string;
}
interface Outcome {
  activeDeploymentId?: string | null;
  maintenance?: boolean;
  state?: string;
  release?: { status: string; error?: string };
  sources?: unknown;
  images?: unknown;
  health?: unknown;
  resolvedSpec?: unknown;
}
export async function runOneJob(db: PrismaClient, client: AgentClient) {
  const workerId = randomUUID();
  const job = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Job" WHERE ((status='queued' AND "availableAt"<=now()) OR (status='running' AND "leaseUntil"<now())) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    return tx.job.update({
      where: { id: rows[0].id },
      data: {
        status: "running",
        attempts: { increment: 1 },
        workerId,
        leaseUntil: new Date(Date.now() + 45000),
        startedAt: new Date(),
      },
      include: { deployment: true },
    });
  });
  if (!job) return false;
  const payload = job.payload as unknown as Payload | null;
  let lastPhase = "";
  let heartbeat: Promise<void> | null = null;
  const beat = async () => {
    await db.job.updateMany({
      where: { id: job.id, workerId, status: "running" },
      data: { leaseUntil: new Date(Date.now() + 45000) },
    });
    const state = (await client({
      operation: "operation-status",
      operationId: job.id,
    })) as AgentStatus | null;
    if (state && state.phase !== lastPhase) {
      lastPhase = state.phase;
      await db.$transaction(async (tx) => {
        const owned = await tx.job.updateMany({
          where: { id: job.id, workerId, status: "running" },
          data: { progress: state.progress },
        });
        if (!owned.count) return;
        await tx.jobEvent.create({
          data: {
            jobId: job.id,
            message: state.phase,
            progress: state.progress,
          },
        });
        if (
          job.deploymentId &&
          deploymentStates.includes(
            state.phase as (typeof deploymentStates)[number],
          ) &&
          state.phase !== "active"
        )
          await tx.deployment.update({
            where: { id: job.deploymentId },
            data: { status: state.phase, startedAt: job.startedAt },
          });
        if (state.phase === "building")
          await tx.project.update({
            where: { id: job.projectId },
            data: { observedState: "building" },
          });
      });
    }
  };
  const timer = setInterval(() => {
    if (!heartbeat)
      heartbeat = beat()
        .catch(() => {})
        .finally(() => {
          heartbeat = null;
        });
  }, 3000);
  let outcome: Outcome | undefined;
  let succeeded = false,
    error = "Agent operation failed",
    retry = false,
    busy = false;
  try {
    const op = operationSchema.parse({
      operation: job.operation,
      projectId: job.projectId,
      operationId: job.id,
      ...(job.operation === "maintenance"
        ? { enabled: payload?.maintenanceEnabled ?? false }
        : {}),
      ...(job.deployment
        ? {
            deploymentId: job.deployment.id,
            ...(payload?.rollbackOf ? { rollbackOf: payload.rollbackOf } : {}),
            spec: job.deployment.spec,
            ...(payload?.encryptedSecrets
              ? { encryptedSecrets: payload.encryptedSecrets }
              : {}),
          }
        : {}),
    });
    const status = (await client({
      operation: "operation-status",
      operationId: job.id,
    })) as AgentStatus | null;
    if (status?.status === "succeeded") {
      succeeded = true;
      outcome = status.result as Outcome;
    } else {
      outcome = (await client(op)) as Outcome;
      succeeded = true;
    }
  } catch (e) {
    const recovered = (await client({
      operation: "operation-status",
      operationId: job.id,
    }).catch(() => null)) as AgentStatus | null;
    if (recovered?.status === "succeeded") {
      succeeded = true;
      outcome = recovered.result as Outcome;
    } else {
      if (recovered?.status === "failed") outcome = recovered.result as Outcome;
      const code = (e as { statusCode?: number }).statusCode;
      busy = code === 409;
      retry =
        recovered?.status !== "failed" &&
        (busy || (!code && job.attempts < job.maxAttempts));
      error = retry
        ? "Agent unavailable; retry scheduled"
        : "Operation failed; inspect events before an explicit retry";
    }
  } finally {
    clearInterval(timer);
    if (heartbeat) await heartbeat;
  }
  await db.$transaction(async (tx) => {
    const latest = await tx.job.findUnique({
      where: { id: job.id },
      select: { progress: true },
    });
    const progress = succeeded ? 100 : (latest?.progress ?? job.progress);
    const changed = await tx.job.updateMany({
      where: { id: job.id, workerId, status: "running" },
      data: {
        status: succeeded
          ? "succeeded"
          : retry
            ? "queued"
            : outcome?.release?.status === "cancelled"
              ? "cancelled"
              : "failed",
        error: succeeded ? null : error,
        progress,
        finishedAt: retry ? null : new Date(),
        leaseUntil: null,
        workerId: null,
        ...(retry
          ? {
              availableAt: new Date(
                Date.now() + 5000 * Math.min(job.attempts, 6),
              ),
              ...(busy ? { attempts: { decrement: 1 } } : {}),
            }
          : {}),
      },
    });
    if (!changed.count) return;
    await tx.jobEvent.create({
      data: {
        jobId: job.id,
        message: succeeded ? "completed" : error,
        progress,
      },
    });
    if (retry) return;
    if (job.deploymentId) {
      if (succeeded)
        await tx.deployment.updateMany({
          where: {
            projectId: job.projectId,
            status: "active",
            id: { not: job.deploymentId },
          },
          data: { status: payload?.rollbackOf ? "rolled_back" : "superseded" },
        });
      await tx.deployment.update({
        where: { id: job.deploymentId },
        data: {
          status: succeeded
            ? "active"
            : outcome?.release?.status === "cancelled"
              ? "cancelled"
              : "failed",
          startedAt: job.startedAt,
          finishedAt: new Date(),
          ...(succeeded ? { activatedAt: new Date() } : {}),
          error: succeeded ? null : (outcome?.release?.error ?? error),
          ...(outcome?.sources ? { sources: json(outcome.sources) } : {}),
          ...(outcome?.images ? { images: json(outcome.images) } : {}),
          ...(outcome?.health ? { health: json(outcome.health) } : {}),
          ...(outcome?.resolvedSpec
            ? { resolvedSpec: json(outcome.resolvedSpec) }
            : {}),
        },
      });
    }
    const observedState =
      outcome?.state ??
      (succeeded
        ? job.operation === "remove"
          ? "deleted"
          : job.operation === "stop"
            ? "stopped"
            : "running"
        : "failed");
    await tx.project.update({
      where: { id: job.projectId },
      data: {
        observedState,
        ...(outcome?.maintenance !== undefined
          ? { maintenanceObserved: outcome.maintenance }
          : {}),
        ...(succeeded && job.deploymentId
          ? { activeDeploymentId: job.deploymentId, runtimeVersion: 3 }
          : {}),
        ...(outcome?.activeDeploymentId !== undefined
          ? { activeDeploymentId: outcome.activeDeploymentId }
          : {}),
        ...(succeeded && payload?.rollbackOf && job.deployment
          ? {
              spec: json(outcome?.resolvedSpec ?? job.deployment.spec),
              encryptedSecrets: job.deployment.encryptedSecrets,
            }
          : {}),
        lastObservedAt: new Date(),
        ...(succeeded && job.operation === "remove"
          ? { deletedAt: new Date() }
          : {}),
      },
    });
    if (succeeded && payload?.rollbackOf && job.deployment)
      await recordServices(
        tx,
        job.projectId,
        applicationSpecSchema.parse(
          outcome?.resolvedSpec ?? job.deployment.spec,
        ),
      );
    if (succeeded && job.operation === "remove")
      await tx.domain.deleteMany({ where: { projectId: job.projectId } });
    if (succeeded && job.deployment) {
      const domains = domainRecords(
        applicationSpecSchema.parse(job.deployment.spec),
      );
      await tx.domain.deleteMany({
        where: {
          projectId: job.projectId,
          hostname: { notIn: domains.map((d) => d.hostname) },
        },
      });
    }
    await audit(
      tx,
      "worker",
      `job.${succeeded ? "succeeded" : "failed"}`,
      job.id,
      job.id,
    );
  });
  return true;
}
export function reconciliationAction(
  desired: string,
  observed: string,
  restore: boolean,
): "start" | "stop" | null {
  if (desired === "running" && observed === "stopped" && restore)
    return "start";
  if (
    desired === "stopped" &&
    (observed === "running" || observed === "degraded")
  )
    return "stop";
  return null;
}
export async function reconcile(db: PrismaClient, client: AgentClient) {
  const projects = await db.project.findMany({
    where: {
      deletedAt: null,
      jobs: { none: { status: { in: ["queued", "running"] } } },
    },
    take: 100,
    orderBy: { lastObservedAt: { sort: "asc", nulls: "first" } },
  });
  for (const project of projects) {
    let state: string;
    let runtime: Outcome;
    try {
      runtime = (await client({
        operation: "inspect",
        projectId: project.id,
      })) as Outcome;
      state = runtime.state ?? "created";
    } catch {
      continue;
    }
    if (!["created", "running", "stopped", "degraded"].includes(state))
      continue;
    await db.$transaction(async (tx) => {
      await projectLock(tx, project.id);
      const current = await tx.project.findUniqueOrThrow({
        where: { id: project.id },
      });
      if (
        current.deletedAt ||
        (await tx.job.findFirst({
          where: {
            projectId: project.id,
            status: { in: ["queued", "running"] },
          },
        }))
      )
        return;
      // Preserve an actionable provisioning failure rather than immediately hiding it with old runtime state.
      const observed =
        current.observedState === "failed"
          ? state === "running"
            ? "degraded"
            : "failed"
          : state;
      await tx.project.update({
        where: { id: project.id },
        data: {
          observedState: observed,
          lastObservedAt: new Date(),
          ...(runtime.maintenance !== undefined
            ? { maintenanceObserved: runtime.maintenance }
            : {}),
          ...(runtime.activeDeploymentId !== undefined
            ? { activeDeploymentId: runtime.activeDeploymentId }
            : {}),
        },
      });
      const action = reconciliationAction(
        current.desiredState,
        state,
        current.restoreOnDrift && current.observedState !== "failed",
      );
      if (action)
        await enqueue(tx, project.id, action, "reconciler", randomUUID());
    });
  }
}
