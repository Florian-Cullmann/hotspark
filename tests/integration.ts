import {
  runSystemTask,
  retainOperationalHistory,
} from "../apps/api/src/operations.js";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
import { hashPassword } from "../packages/shared/src/index.js";
import {
  runOneJob,
  reconcile,
  reconciliationAction,
  type AgentClient,
} from "../apps/api/src/worker.js";
import { HotsparkClient } from "../packages/sdk/src/index.js";
import { applicationSpecSchema } from "../packages/application-spec/src/index.js";
import { unseal } from "../packages/shared/src/secrets.js";
const key = "c".repeat(64),
  db = new PrismaClient();
const states = new Map<string, string>(),
  completed = new Map<string, unknown>();
let dispatches = 0,
  unavailable = false;
const agent: AgentClient = async (op) => {
  if (unavailable) throw new Error("Disconnected");
  if (op.operation === "host-info") return {};
  if (op.operation === "operation-status")
    return completed.has(op.operationId)
      ? {
          status: "succeeded",
          result: completed.get(op.operationId),
          progress: 100,
          phase: "complete",
        }
      : null;
  if (op.operation === "inspect")
    return { state: states.get(op.projectId) ?? "stopped", services: [] };
  if (op.operation === "logs") return { text: "bounded log" };
  dispatches++;
  const state =
    op.operation === "remove"
      ? "deleted"
      : op.operation === "stop"
        ? "stopped"
        : "running";
  if ("projectId" in op && op.projectId) states.set(op.projectId, state);
  const result = { state };
  if (!("operationId" in op)) return {};
  completed.set(op.operationId, result);
  return result;
};
const app = await createApp(db, { secretsKey: key, agent });
try {
  await db.user.create({
    data: {
      email: "admin@localhost",
      passwordHash: await hashPassword("integration-password"),
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: "admin@localhost", password: "integration-password" },
  });
  assert.equal(login.statusCode, 200);
  const headers = { authorization: `Bearer ${login.json().token}` };
  const spec = {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: "integration" },
    services: {
      web: {
        type: "node",
        source: {
          type: "git",
          repository: "https://github.com/example/app.git",
          commit: "a".repeat(40),
        },
        database: "database",
        secrets: ["API_KEY"],
        domains: ["integration.example.com"],
      },
      database: { type: "postgres", version: "17" },
    },
  };
  const payload = {
    spec,
    secrets: { web: { API_KEY: "hidden-sensitive-value" } },
  };
  const calls = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...headers, "idempotency-key": "create-1" },
        payload,
      }),
    ),
  );
  assert.ok(
    calls.every((c) => c.statusCode === 202),
    calls.map((c) => c.body).join("\n"),
  );
  assert.equal(calls[0]!.json().jobId, calls[1]!.json().jobId);
  const { projectId: id, jobId } = calls[0]!.json() as {
    projectId: string;
    jobId: string;
  };
  assert.equal(await db.project.count(), 1);
  assert.equal(await db.job.count(), 1);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...headers, "idempotency-key": "create-1" },
        payload: {
          ...payload,
          spec: { ...spec, metadata: { name: "different" } },
        },
      })
    ).statusCode,
    409,
  );
  const project = await db.project.findUniqueOrThrow({ where: { id } });
  assert.ok(!JSON.stringify(project).includes("hidden-sensitive-value"));
  assert.equal(
    unseal<Record<string, Record<string, string>>>(
      project.encryptedSecrets!,
      key,
      `project:${id}`,
    ).web!.API_KEY,
    "hidden-sensitive-value",
  );
  const read = await app.inject({ url: `/api/v1/projects/${id}`, headers });
  assert.ok(!read.body.includes("encryptedSecrets"));
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: {
          ...payload,
          spec: { ...spec, metadata: { name: "duplicate-domain" } },
        },
      })
    ).statusCode,
    409,
  );
  const token = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers,
    payload: { name: "reader", scopes: ["projects:read"] },
  });
  assert.equal(token.statusCode, 201);
  const readHeaders = { authorization: `Bearer ${token.json().token}` };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/projects/${id}/stop`,
        headers: readHeaders,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/v1/projects/${id}/logs?service=web`,
        headers: readHeaders,
      })
    ).statusCode,
    403,
  );
  await runOneJob(db, agent);
  assert.equal(
    (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status,
    "succeeded",
  );
  assert.equal(
    (await db.project.findUniqueOrThrow({ where: { id } })).observedState,
    "running",
  );
  const lostAck = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${id}/start`,
    headers,
  });
  assert.equal(lostAck.statusCode, 202, lostAck.body);
  await db.job.update({
    where: { id: lostAck.json().jobId },
    data: { maxAttempts: 1 },
  });
  const beforeLostAck = dispatches;
  await runOneJob(db, async (op) => {
    const result = await agent(op);
    if (op.operation === "start")
      throw new Error("Response lost after durable success");
    return result;
  });
  assert.equal(
    (await db.job.findUniqueOrThrow({ where: { id: lostAck.json().jobId } }))
      .status,
    "succeeded",
  );
  assert.equal(dispatches, beforeLostAck + 1);
  const editor = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers,
    payload: { name: "editor", scopes: ["projects:update"] },
  });
  assert.equal(editor.statusCode, 201);
  const editorHeaders = { authorization: `Bearer ${editor.json().token}` };
  const deniedDomains = await app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${id}`,
    headers: editorHeaders,
    payload: {
      spec: {
        ...spec,
        services: {
          ...spec.services,
          web: { ...spec.services.web, domains: ["unauthorized.example.com"] },
        },
      },
    },
  });
  assert.equal(deniedDomains.statusCode, 403, deniedDomains.body);
  const allowedConfig = await app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${id}`,
    headers: editorHeaders,
    payload: { restoreOnDrift: true },
  });
  assert.equal(allowedConfig.statusCode, 202, allowedConfig.body);
  await runOneJob(db, agent);
  // Simulate a control-plane crash after the agent completed but before the DB commit.
  await db.job.update({
    where: { id: jobId },
    data: { status: "running", leaseUntil: new Date(0) },
  });
  const before = dispatches;
  await runOneJob(db, agent);
  assert.equal(dispatches, before);
  states.set(id, "stopped");
  await reconcile(db, agent);
  assert.equal(await db.job.count({ where: { status: "queued" } }), 1);
  await runOneJob(db, agent);
  assert.equal(states.get(id), "running");
  assert.equal(reconciliationAction("running", "degraded", true), null);
  const stop = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${id}/stop`,
    headers,
  });
  assert.equal(stop.statusCode, 202);
  unavailable = true;
  await runOneJob(db, agent);
  unavailable = false;
  const stopId = stop.json().jobId;
  assert.equal(
    (await db.job.findUniqueOrThrow({ where: { id: stopId } })).status,
    "queued",
  );
  const retryCancel = await app.inject({
    method: "POST",
    url: `/api/v1/jobs/${stopId}/cancel`,
    headers,
  });
  assert.equal(retryCancel.statusCode, 409);
  await db.job.update({
    where: { id: stopId },
    data: { availableAt: new Date(0) },
  });
  await runOneJob(db, agent);
  assert.equal(states.get(id), "stopped");
  const restart = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${id}/start`,
    headers,
  });
  assert.equal(restart.statusCode, 202);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/jobs/${restart.json().jobId}/cancel`,
        headers,
      })
    ).statusCode,
    200,
  );
  const patch = await app.inject({
    method: "PATCH",
    url: `/api/v1/projects/${id}`,
    headers,
    payload: {
      spec: {
        ...spec,
        services: {
          ...spec.services,
          web: { ...spec.services.web, environment: { GREETING: "hello" } },
        },
      },
      secrets: { web: { API_KEY: "new-secret-value" } },
    },
  });
  assert.equal(patch.statusCode, 202, patch.body);
  await runOneJob(db, agent);
  const domain = await app.inject({
    method: "PUT",
    url: `/api/v1/projects/${id}/domains`,
    headers,
    payload: { service: "web", domains: ["NEW.EXAMPLE.COM"] },
  });
  assert.equal(domain.statusCode, 202, domain.body);
  assert.equal(
    await db.domain.count({ where: { projectId: id } }),
    2,
    "old domain held until runtime changes",
  );
  await runOneJob(db, agent);
  assert.equal(await db.domain.count({ where: { projectId: id } }), 1);
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/tokens/${token.json().id}`,
        headers,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (await app.inject({ url: "/api/v1/projects", headers: readHeaders }))
      .statusCode,
    401,
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 }),
    sdk = new HotsparkClient(address, login.json().token);
  const sdkCreated = await sdk.createProject(
    applicationSpecSchema.parse({
      ...spec,
      metadata: { name: "sdk-project" },
      services: { web: { type: "react", source: spec.services.web.source } },
    }),
    {},
    "sdk-create",
  );
  assert.ok(sdkCreated.jobId);
  const removed = await app.inject({
    method: "DELETE",
    url: `/api/v1/projects/${id}`,
    headers,
  });
  assert.equal(removed.statusCode, 202);
  await runOneJob(db, agent);
  await runOneJob(db, agent);
  assert.equal(
    (await app.inject({ url: `/api/v1/projects/${id}`, headers })).statusCode,
    404,
  );
  assert.equal(await db.domain.count({ where: { projectId: id } }), 0);
  assert.ok(
    (await db.project.findUniqueOrThrow({ where: { id } })).encryptedSecrets,
    "retains encrypted recovery data",
  );
  const operational = await app.inject({
    method: "POST",
    url: "/api/v1/system/backups",
    headers: { ...headers, "idempotency-key": "backup-once" },
    payload: {},
  });
  assert.equal(operational.statusCode, 202);
  const replay = await app.inject({
    method: "POST",
    url: "/api/v1/system/backups",
    headers: { ...headers, "idempotency-key": "backup-once" },
    payload: {},
  });
  assert.equal(replay.json().taskId, operational.json().taskId);
  let executions = 0;
  const journal = new Map<string, unknown>();
  const operationsAgent: AgentClient = async (op) => {
    if (op.operation === "system-task-status")
      return journal.get(op.taskId) ?? null;
    if (op.operation === "backup") {
      executions++;
      const result = { artifacts: [{ sha256: "a".repeat(64), bytes: 123 }] };
      journal.set(op.taskId, { status: "succeeded", result });
      throw new Error("lost acknowledgement");
    }
    return agent(op);
  };
  await runSystemTask(db, operationsAgent);
  const done = await db.systemTask.findUniqueOrThrow({
    where: { id: operational.json().taskId },
  });
  assert.equal(done.status, "succeeded");
  assert.equal(executions, 1);
  const forbiddenToken = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers,
    payload: { name: "readonly-operations", scopes: ["projects:read"] },
  });
  const forbiddenHeaders = {
    authorization: `Bearer ${forbiddenToken.json().token}`,
  };
  for (const url of [
    "/api/v1/system/doctor",
    "/api/v1/system/metrics",
    "/api/v1/system/tasks",
  ])
    assert.equal(
      (await app.inject({ url, headers: forbiddenHeaders })).statusCode,
      403,
    );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/system/backups",
        headers: forbiddenHeaders,
        payload: {},
      })
    ).statusCode,
    403,
  );
  const monitoring = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers,
    payload: { name: "monitor", scopes: ["system:read"] },
  });
  const monitorHeaders = { authorization: `Bearer ${monitoring.json().token}` };
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/system/metrics",
        headers: monitorHeaders,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/system/backups",
        headers: monitorHeaders,
        payload: {},
      })
    ).statusCode,
    403,
  );
  const metric = await app.inject({ url: "/api/v1/system/metrics", headers });
  assert.equal(metric.statusCode, 200);
  assert.ok(metric.body.includes("hotspark_queue_depth"));
  assert.ok(!metric.body.includes("new-secret-value"));
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: forbiddenHeaders,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (await app.inject({ url: "/api/v1/projects", headers: forbiddenHeaders }))
      .statusCode,
    401,
  );
  const updateGate = await app.inject({
    method: "POST",
    url: "/api/v1/system/updates",
    headers,
    payload: { version: "0.4.1", sha256: "a".repeat(64) },
  });
  assert.equal(updateGate.statusCode, 202);
  const duringUpdate = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${sdkCreated.projectId}/restart`,
    headers,
  });
  assert.equal(
    duringUpdate.statusCode,
    409,
    "update gate protects agent replacement",
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/system/backups",
        headers,
        payload: {},
      })
    ).statusCode,
    409,
  );
  await db.systemTask.update({
    where: { id: updateGate.json().taskId },
    data: { status: "failed", finishedAt: new Date() },
  });
  const oldTask = await db.systemTask.create({
    data: {
      kind: "backup",
      input: {},
      actorId: "fixture",
      status: "succeeded",
      finishedAt: new Date(Date.now() - 200 * 86400000),
    },
  });
  await retainOperationalHistory(db);
  assert.equal(
    await db.systemTask.findUnique({ where: { id: oldTask.id } }),
    null,
  );
  assert.ok(
    await db.systemTask.findUnique({
      where: { id: operational.json().taskId },
    }),
    "recent task result retained",
  );
  console.log(
    "Integration passed: async provisioning, idempotency, encryption, permissions, domain reservations, durable replay, retries, reconciliation, cancellation, patch, delete, SDK and migrations.",
  );
} finally {
  await app.close();
  await db.$disconnect();
}
