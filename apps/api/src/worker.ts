import type { PrismaClient } from "../../../packages/database/src/index.js";
import { operationSchema } from "../../../packages/application-spec/src/index.js";
import { agentRequest } from "../../../packages/shared/src/index.js";
export async function runOneJob(db: PrismaClient, socket: string) {
  const job = await db.$transaction(async (tx) => {
    const candidate = await tx.job.findFirst({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      include: { deployment: true },
    });
    if (!candidate) return null;
    const claimed = await tx.job.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "running", startedAt: new Date() },
    });
    return claimed.count ? candidate : null;
  });
  if (!job) return;
  let status = "succeeded";
  let error: string | null = null;
  try {
    const operation = operationSchema.parse({
      operation: job.operation,
      projectId: job.projectId,
      ...(job.deployment
        ? { deploymentId: job.deployment.id, spec: job.deployment.spec }
        : {}),
    });
    await agentRequest(socket, operation);
  } catch {
    status = "failed";
    error =
      "Agent operation failed; inspect host logs and runtime before retrying";
  }
  await db.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: { status, error, finishedAt: new Date() },
    });
    if (job.deploymentId)
      await tx.deployment.update({
        where: { id: job.deploymentId },
        data: { status },
      });
    await tx.auditEvent.create({
      data: {
        actorId: "worker",
        action: `job.${status}`,
        resourceId: job.id,
        requestId: job.id,
      },
    });
  });
}
