import { Prisma as PrismaValue } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import type { AgentClient } from "./worker.js";
import { operationSchema } from "../../../packages/application-spec/src/index.js";
import { json } from "./projects.js";
export const platformVersion = process.env.HOTSPARK_VERSION ?? "0.4.0";
export async function emitEvent(
  tx: Prisma.TransactionClient | PrismaClient,
  type: string,
  resourceId: string,
  key: string,
) {
  await tx.platformEvent.upsert({
    where: { key },
    create: { type, resourceId, key },
    update: {},
  });
}
export async function doctor(db: PrismaClient, agent: AgentClient) {
  const checks: { name: string; status: string; detail: string }[] = [];
  let host: Record<string, unknown> | null = null;
  try {
    await db.$queryRaw`SELECT 1`;
    checks.push({
      name: "database",
      status: "ok",
      detail: "Control-plane database responds",
    });
  } catch {
    checks.push({
      name: "database",
      status: "error",
      detail: "Control-plane database unavailable",
    });
  }
  try {
    host = (await agent({ operation: "diagnostics" })) as Record<
      string,
      unknown
    >;
    checks.push({
      name: "agent",
      status: "ok",
      detail: "Authenticated agent responds",
    });
  } catch {
    checks.push({
      name: "agent",
      status: "error",
      detail: "Agent unavailable",
    });
  }
  const hostChecks = host?.checks as
    | { name: string; status: string }[]
    | undefined;
  for (const name of ["disk", "certificates"])
    if (hostChecks?.some((c) => c.name === name && c.status === "warning"))
      await emitEvent(
        db,
        name === "disk" ? "disk.pressure" : "certificate.issue",
        "host",
        `${name}:${new Date().toISOString().slice(0, 10)}`,
      );
  const stuck = await db.job.count({
    where: {
      OR: [
        { status: "running", leaseUntil: { lt: new Date() } },
        {
          status: "queued",
          createdAt: { lt: new Date(Date.now() - 30 * 60000) },
        },
      ],
    },
  });
  checks.push({
    name: "jobs",
    status: stuck ? "warning" : "ok",
    detail: `${stuck} expired leases or jobs queued over 30 minutes`,
  });
  const stale = await db.project.count({
    where: {
      deletedAt: null,
      OR: [
        { lastObservedAt: null },
        { lastObservedAt: { lt: new Date(Date.now() - 120000) } },
      ],
    },
  });
  checks.push({
    name: "reconciliation",
    status: stale ? "warning" : "ok",
    detail: `${stale} projects have no observation in the last two minutes`,
  });
  const deployments = await db.deployment.count({
    where: {
      status: {
        in: [
          "cloning",
          "building",
          "migrating",
          "starting",
          "healthchecking",
          "activating",
        ],
      },
      startedAt: { lt: new Date(Date.now() - 3600000) },
    },
  });
  checks.push({
    name: "deployments",
    status: deployments ? "warning" : "ok",
    detail: `${deployments} deployments have exceeded one hour`,
  });
  const size = await db.$queryRaw<
    { bytes: bigint }[]
  >`SELECT pg_database_size(current_database()) AS bytes`;
  return {
    version: platformVersion,
    checkedAt: new Date().toISOString(),
    checks,
    host,
    databaseBytes: Number(size[0]?.bytes ?? 0),
    redaction:
      "No credentials, repository URLs, host addresses, domains, or workload environment values included",
  };
}
export async function metrics(db: PrismaClient, agent: AgentClient) {
  const projects = await db.project.groupBy({
    by: ["observedState"],
    where: { deletedAt: null },
    _count: true,
  });
  const queued = await db.job.count({ where: { status: "queued" } });
  const deployments = await db.deployment.groupBy({
    by: ["status"],
    _count: true,
  });
  const durations = await db.$queryRaw<
    { count: bigint; seconds: number | null }[]
  >`SELECT count(*) AS count, sum(extract(epoch from ("finishedAt" - "startedAt")))::float8 AS seconds FROM "Deployment" WHERE "finishedAt" IS NOT NULL AND "startedAt" IS NOT NULL`;
  const buildDurations = await db.deployment.aggregate({
    where: { buildDurationMs: { not: null } },
    _count: { buildDurationMs: true },
    _sum: { buildDurationMs: true },
  });
  let healthy = 0;
  try {
    await agent({ operation: "host-info" });
    healthy = 1;
  } catch {
    /* metric remains zero */
  }
  const lines = [
    "# TYPE hotspark_projects gauge",
    ...projects.map(
      (p) =>
        `hotspark_projects{state="${p.observedState.replace(/[^a-z_]/g, "")}"} ${p._count}`,
    ),
    "# TYPE hotspark_queue_depth gauge",
    `hotspark_queue_depth ${queued}`,
    "# TYPE hotspark_agent_health gauge",
    `hotspark_agent_health ${healthy}`,
    "# TYPE hotspark_unhealthy_applications gauge",
    `hotspark_unhealthy_applications ${projects.filter((p) => ["failed", "degraded"].includes(p.observedState)).reduce((a, p) => a + p._count, 0)}`,
    "# TYPE hotspark_deployments gauge",
    ...deployments.map(
      (d) =>
        `hotspark_deployments{status="${d.status.replace(/[^a-z_]/g, "")}"} ${d._count}`,
    ),
    "# TYPE hotspark_deployment_duration_seconds summary",
    `hotspark_deployment_duration_seconds_count ${durations[0]?.count ?? 0}`,
    `hotspark_deployment_duration_seconds_sum ${Math.max(0, durations[0]?.seconds ?? 0)}`,
  ];
  lines.push(
    "# TYPE hotspark_build_duration_seconds summary",
    `hotspark_build_duration_seconds_count ${buildDurations._count.buildDurationMs}`,
    `hotspark_build_duration_seconds_sum ${(buildDurations._sum.buildDurationMs ?? 0) / 1000}`,
  );
  return lines.join("\n") + "\n";
}
export async function runSystemTask(db: PrismaClient, agent: AgentClient) {
  const workerId = randomUUID();
  const task = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "SystemTask" WHERE status='queued' OR (status='running' AND "leaseUntil"<now()) ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!rows[0]) return null;
    return tx.systemTask.update({
      where: { id: rows[0].id },
      data: {
        status: "running",
        workerId,
        attempts: { increment: 1 },
        leaseUntil: new Date(Date.now() + 45000),
        startedAt: new Date(),
      },
    });
  });
  if (!task) return false;
  let beat: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (!beat)
      beat = db.systemTask
        .updateMany({
          where: { id: task.id, workerId, status: "running" },
          data: { leaseUntil: new Date(Date.now() + 45000) },
        })
        .catch(() => {})
        .finally(() => {
          beat = undefined;
        });
  }, 10000);
  let result: unknown,
    status = "succeeded",
    error: string | null = null;
  try {
    const op = operationSchema.parse({
      ...(task.input as object),
      operation: task.kind,
      taskId: task.id,
    });
    const journal = (await agent({
      operation: "system-task-status",
      taskId: task.id,
    })) as { status: string; result?: unknown } | null;
    if (journal?.status === "succeeded") result = journal.result;
    else result = await agent(op);
    // Update runner survives API replacement; poll its journal on the next lease.
    if (
      task.kind === "platform-update" &&
      (result as { status?: string })?.status === "running"
    )
      status = "running";
  } catch (e) {
    const journal = (await agent({
      operation: "system-task-status",
      taskId: task.id,
    }).catch(() => null)) as { status: string; result?: unknown } | null;
    if (journal?.status === "succeeded") result = journal.result;
    else if (
      journal?.status !== "failed" &&
      (task.attempts < 3 ||
        ((e as { statusCode?: number }).statusCode === 409 &&
          Date.now() - task.createdAt.getTime() < 3600000))
    )
      status = "queued";
    else {
      status = "failed";
      error =
        "Operational task failed; inspect doctor and root-only task journal";
    }
  } finally {
    clearInterval(timer);
    if (beat) await beat;
  }
  await db.$transaction(async (tx) => {
    const changed = await tx.systemTask.updateMany({
      where: { id: task.id, workerId },
      data: {
        status,
        error,
        ...(result !== undefined
          ? { result: json(result) }
          : status === "failed"
            ? { result: PrismaValue.JsonNull }
            : {}),
        leaseUntil: status === "running" ? new Date(Date.now() + 30000) : null,
        finishedAt: ["succeeded", "failed"].includes(status)
          ? new Date()
          : null,
      },
    });
    if (changed.count && ["succeeded", "failed"].includes(status)) {
      await tx.auditEvent.create({
        data: {
          actorId: task.actorId,
          action: `${task.kind}.${status}`,
          resourceId: task.id,
          requestId: task.id,
        },
      });
      if (status === "failed")
        await emitEvent(
          tx,
          task.kind === "backup" ? "backup.failed" : "operation.failed",
          task.id,
          `task:${task.id}`,
        );
    }
  });
  return true;
}
export async function retainOperationalHistory(db: PrismaClient) {
  const before = (days: number) => new Date(Date.now() - days * 86400000);
  await db.jobEvent.deleteMany({
    where: {
      createdAt: { lt: before(30) },
      job: { status: { notIn: ["queued", "running"] } },
    },
  });
  await db.auditEvent.deleteMany({ where: { createdAt: { lt: before(180) } } });
  await db.platformEvent.deleteMany({
    where: { createdAt: { lt: before(30) } },
  });
  await db.idempotencyRecord.deleteMany({
    where: { createdAt: { lt: before(7) } },
  });
  // Disk release journals remain the recovery archive; prune old terminal database detail.
  const oldJobs = {
    status: { notIn: ["queued", "running"] },
    finishedAt: { lt: before(30) },
  };
  await db.jobEvent.deleteMany({ where: { job: oldJobs } });
  await db.job.deleteMany({ where: oldJobs });
  await db.systemTask.deleteMany({
    where: {
      status: { in: ["succeeded", "failed"] },
      finishedAt: { lt: before(180) },
    },
  });
  let cursor: string | undefined;
  while (true) {
    const projects = await db.project.findMany({
      take: 100,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, activeDeploymentId: true },
    });
    if (!projects.length) break;
    for (const p of projects) {
      const recent = await db.deployment.findMany({
        where: {
          projectId: p.id,
          status: { in: ["active", "superseded", "rolled_back"] },
        },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true },
      });
      const active = p.activeDeploymentId
        ? await db.deployment.findUnique({
            where: { id: p.activeDeploymentId },
            select: { previousReleaseId: true },
          })
        : null;
      const keep = [
        ...recent.map((r) => r.id),
        p.activeDeploymentId,
        active?.previousReleaseId,
      ].filter((id): id is string => !!id);
      await db.deployment.deleteMany({
        where: {
          projectId: p.id,
          id: { notIn: keep },
          status: { in: ["failed", "cancelled", "superseded", "rolled_back"] },
          finishedAt: { lt: before(180) },
          jobs: { none: {} },
        },
      });
    }
    cursor = projects.at(-1)!.id;
  }
}

export async function monitorOperationalHealth(
  db: PrismaClient,
  agent: AgentClient,
) {
  const report = (await agent({ operation: "diagnostics" })) as {
    checks: { name: string; status: string }[];
  };
  for (const name of ["disk", "certificates"])
    if (report.checks.some((c) => c.name === name && c.status === "warning"))
      await emitEvent(
        db,
        name === "disk" ? "disk.pressure" : "certificate.issue",
        "host",
        `${name}:${new Date().toISOString().slice(0, 10)}`,
      );
}
