import { Prisma, type PrismaClient } from "@prisma/client";
import { randomUUID, createHmac } from "node:crypto";
import {
  applicationSpecSchema,
  type ApplicationSpec,
} from "../../../packages/application-spec/src/index.js";
import { stableHash } from "../../../packages/providers/src/index.js";
import { seal, unseal } from "../../../packages/shared/src/secrets.js";
export function fail(statusCode: number, message = "Request rejected"): never {
  throw Object.assign(new Error(message), { statusCode });
}
export const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export const activeJobs = ["queued", "running"];
export function publicProject<T extends { encryptedSecrets: string | null }>(
  project: T,
) {
  const { encryptedSecrets, ...safe } = project;
  void encryptedSecrets;
  return {
    ...safe,
    ...("spec" in safe ? { spec: applicationSpecSchema.parse(safe.spec) } : {}),
  };
}
export function publicDeployment<T extends { encryptedSecrets: string | null }>(
  deployment: T,
) {
  const { encryptedSecrets, ...safe } = deployment;
  void encryptedSecrets;
  return safe;
}
export function publicJob<
  T extends { payload: unknown; workerId: string | null },
>(job: T) {
  const { payload, workerId, ...safe } = job;
  void payload;
  void workerId;
  return safe;
}
export function domainRecords(spec: ApplicationSpec) {
  return Object.entries(spec.services).flatMap(([serviceName, s]) =>
    s.type !== "postgres"
      ? s.domains.map((hostname) => ({ hostname, serviceName }))
      : [],
  );
}
export async function reserveDomains(
  tx: Prisma.TransactionClient,
  projectId: string,
  spec: ApplicationSpec,
) {
  for (const d of domainRecords(spec)) {
    const existing = await tx.domain.findUnique({
      where: { hostname: d.hostname },
    });
    if (existing && existing.projectId !== projectId)
      fail(409, "Domain is already reserved");
    if (existing)
      await tx.domain.update({
        where: { id: existing.id },
        data: { serviceName: d.serviceName },
      });
    else await tx.domain.create({ data: { projectId, ...d } });
  }
}
export async function recordServices(
  tx: Prisma.TransactionClient,
  projectId: string,
  spec: ApplicationSpec,
) {
  await tx.service.deleteMany({ where: { projectId } });
  await tx.service.createMany({
    data: Object.entries(spec.services).map(([name, s]) => ({
      projectId,
      name,
      type: s.type,
    })),
  });
}
export async function audit(
  tx: Prisma.TransactionClient,
  actorId: string,
  action: string,
  resourceId: string,
  requestId: string,
) {
  await tx.auditEvent.create({
    data: { actorId, action, resourceId, requestId },
  });
}
export async function projectLock(tx: Prisma.TransactionClient, id: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
}
export async function platformGate(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hotspark:platform-update'))`;
  if (
    await tx.systemTask.findFirst({
      where: { kind: "platform-update", status: { in: ["queued", "running"] } },
      select: { id: true },
    })
  )
    fail(409, "Platform update is in progress");
}
export async function enqueue(
  tx: Prisma.TransactionClient,
  projectId: string,
  operation: string,
  actorId: string,
  requestId: string,
  options: {
    rollbackOf?: string;
    tokenId?: string;
    maintenanceEnabled?: boolean;
  } = {},
) {
  await platformGate(tx);
  const p = await tx.project.findUniqueOrThrow({ where: { id: projectId } });
  if (["deploy", "maintenance"].includes(operation) && p.runtimeVersion < 2)
    fail(409, "Legacy project requires explicit migration");
  if (
    await tx.job.findFirst({ where: { projectId, status: { in: activeJobs } } })
  )
    fail(409, "Project has an active job");
  const target = options.rollbackOf
    ? await tx.deployment.findUnique({ where: { id: options.rollbackOf } })
    : null;
  if (
    options.rollbackOf &&
    (!target ||
      target.projectId !== projectId ||
      !["active", "superseded", "rolled_back"].includes(target.status))
  )
    fail(409, "Rollback requires a successful release from this project");
  const releaseSpec = applicationSpecSchema.parse(
    target?.resolvedSpec ?? target?.spec ?? p.spec,
  );
  const deployment =
    operation === "deploy"
      ? await tx.deployment.create({
          data: {
            projectId,
            spec: json(releaseSpec),
            actorId,
            sources: json(
              Object.entries(releaseSpec.services).flatMap(([service, s]) =>
                s.type !== "postgres" && s.source.type === "git"
                  ? [
                      {
                        service,
                        repository: s.source.repository,
                        commit: s.source.commit,
                        branch: s.source.branch,
                        tag: s.source.tag,
                      },
                    ]
                  : [],
              ),
            ),
            encryptedSecrets: target
              ? target.encryptedSecrets
              : p.encryptedSecrets,
            tokenId: options.tokenId,
            previousReleaseId: p.activeDeploymentId,
            rollbackOfId: options.rollbackOf,
            maintenancePolicy: releaseSpec.deployment.maintenance,
          },
        })
      : null;
  const desiredState =
    operation === "maintenance"
      ? p.desiredState
      : operation === "stop"
        ? "stopped"
        : operation === "remove"
          ? "deleted"
          : "running";
  const job = await tx.job.create({
    data: {
      projectId,
      operation,
      deploymentId: deployment?.id,
      payload: json({
        spec: p.spec,
        encryptedSecrets: target ? target.encryptedSecrets : p.encryptedSecrets,
        revision: p.revision,
        previousDesiredState: p.desiredState,
        previousObservedState: p.observedState,
        rollbackOf: options.rollbackOf,
        maintenanceEnabled: options.maintenanceEnabled,
        previousMaintenance: p.maintenanceEnabled,
      }),
      events: { create: { message: "queued", progress: 0 } },
    },
  });
  await tx.project.update({
    where: { id: projectId },
    data: {
      desiredState,
      ...(operation === "maintenance"
        ? { maintenanceEnabled: options.maintenanceEnabled }
        : {}),
      observedState:
        operation === "remove"
          ? "deleting"
          : operation === "deploy"
            ? "provisioning"
            : p.observedState,
    },
  });
  await audit(tx, actorId, `project.${operation}`, projectId, requestId);
  return {
    projectId,
    jobId: job.id,
    ...(deployment ? { deploymentId: deployment.id } : {}),
    job: publicJob(job),
  };
}
export async function idempotent(
  db: PrismaClient,
  actorId: string,
  key: string | undefined,
  input: unknown,
  work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  hashKey: string,
) {
  if (key && !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
    fail(400, "Invalid idempotency key");
  const requestHash = createHmac("sha256", hashKey)
    .update(stableHash(input))
    .digest("hex");
  return db.$transaction(
    async (tx) => {
      if (key) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${actorId}:${key}`}))`;
        const record = await tx.idempotencyRecord.findUnique({
          where: { actorId_key: { actorId, key } },
        });
        if (record) {
          if (record.requestHash !== requestHash)
            fail(409, "Idempotency key used with a different request");
          return record.response;
        }
      }
      const response = await work(tx);
      if (key)
        await tx.idempotencyRecord.create({
          data: {
            actorId,
            key,
            requestHash,
            response: json(response),
          },
        });
      return response;
    },
    { timeout: 15000 },
  );
}
export function mergeSecrets(
  id: string,
  spec: ApplicationSpec,
  previous: string | null,
  input: Record<string, Record<string, string>>,
  key: string,
) {
  const values = previous
    ? unseal<Record<string, Record<string, string>>>(
        previous,
        key,
        `project:${id}`,
      )
    : {};
  for (const [service, entries] of Object.entries(input)) {
    const s = spec.services[service];
    if (!s || s.type === "postgres") fail(400, "Unknown secret service");
    for (const name of Object.keys(entries))
      if (!s.secrets.includes(name))
        fail(400, "Secrets must be declared in the service specification");
    values[service] = { ...values[service], ...entries };
  }
  const selected: Record<string, Record<string, string>> = {};
  for (const [name, s] of Object.entries(spec.services))
    if (s.type !== "postgres") {
      selected[name] = {};
      for (const k of s.secrets) {
        if (!values[name]?.[k]) fail(400, "Missing declared secret");
        selected[name]![k] = values[name]![k]!;
      }
    }
  if (Buffer.byteLength(JSON.stringify(selected)) > 192 * 1024)
    fail(400, "Project secret data exceeds 192 KiB");
  return seal(selected, key, `project:${id}`);
}
export async function createProject(
  tx: Prisma.TransactionClient,
  spec: ApplicationSpec,
  secrets: Record<string, Record<string, string>>,
  key: string,
  actorId: string,
  requestId: string,
) {
  const id = randomUUID();
  await tx.project.create({
    data: {
      id,
      name: spec.metadata.name,
      spec: json(spec),
      runtimeVersion: 3,
      encryptedSecrets: mergeSecrets(id, spec, null, secrets, key),
    },
  });
  await recordServices(tx, id, spec);
  await reserveDomains(tx, id, spec);
  await audit(tx, actorId, "project.create", id, requestId);
  return enqueue(tx, id, "deploy", actorId, requestId);
}
export async function updateProject(
  tx: Prisma.TransactionClient,
  id: string,
  specInput: unknown,
  secrets: Record<string, Record<string, string>>,
  key: string,
  actorId: string,
  requestId: string,
  restoreOnDrift?: boolean,
  canManageDomains = true,
) {
  await projectLock(tx, id);
  const p = await tx.project.findUnique({ where: { id } });
  if (!p || p.deletedAt) fail(404);
  if (p.runtimeVersion < 2)
    fail(409, "Legacy deployment requires explicit migration before editing");
  if (
    await tx.job.findFirst({
      where: { projectId: id, status: { in: activeJobs } },
    })
  )
    fail(409, "Project has an active job");
  const spec = applicationSpecSchema.parse(specInput ?? p.spec),
    old = applicationSpecSchema.parse(p.spec);
  for (const [name, s] of Object.entries(old.services))
    if (
      s.type === "postgres" &&
      (spec.services[name]?.type !== "postgres" ||
        (spec.services[name] as { version?: string }).version !== s.version)
    )
      fail(
        409,
        "Removing, renaming or changing the major version of a database requires an explicit data migration",
      );
  if (
    !canManageDomains &&
    stableHash(domainRecords(old)) !== stableHash(domainRecords(spec))
  )
    fail(403, "Domain changes require domains:manage");
  await reserveDomains(tx, id, spec);
  await tx.project.update({
    where: { id },
    data: {
      spec: json(spec),
      name: spec.metadata.name,
      revision: { increment: 1 },
      encryptedSecrets: mergeSecrets(
        id,
        spec,
        p.encryptedSecrets,
        secrets,
        key,
      ),
      ...(restoreOnDrift === undefined ? {} : { restoreOnDrift }),
    },
  });
  await recordServices(tx, id, spec);
  return enqueue(tx, id, "deploy", actorId, requestId);
}
