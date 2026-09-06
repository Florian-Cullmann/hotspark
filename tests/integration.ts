import { HotsparkClient } from "../packages/sdk/src/index.js";
import { applicationSpecSchema } from "../packages/application-spec/src/index.js";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
import { hashPassword } from "../packages/shared/src/index.js";
const db = new PrismaClient();
const app = await createApp(db);
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
  const token = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers,
    payload: { name: "read only", scopes: ["read"] },
  });
  assert.equal(token.statusCode, 201);
  const payload = {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: "integration" },
    services: {
      web: {
        type: "web",
        source: {
          type: "image",
          image: "example/web@sha256:" + "a".repeat(64),
        },
        runtime: { port: 3000 },
        domains: ["integration.example.com"],
      },
    },
  };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload,
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  const denied = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${id}/deploy`,
    headers: { authorization: `Bearer ${token.json().token}` },
  });
  assert.equal(denied.statusCode, 403);
  const duplicate = await app.inject({
    method: "POST",
    url: "/api/v1/projects",
    headers,
    payload: { ...payload, metadata: { name: "duplicate-domain" } },
  });
  assert.equal(duplicate.statusCode, 409);
  const results = await Promise.all(
    [1, 2].map(() =>
      app.inject({
        method: "POST",
        url: `/api/v1/projects/${id}/deploy`,
        headers,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [202, 409]);
  assert.equal(await db.job.count(), 1);
  assert.equal(await db.deployment.count(), 1);
  assert.ok((await db.auditEvent.count()) >= 4);
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
    (
      await app.inject({
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${token.json().token}` },
      })
    ).statusCode,
    401,
  );
  assert.equal((await app.inject("/api/v1/ready")).statusCode, 200);
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const sdk = new HotsparkClient(address, login.json().token);
  const sdkProject = await sdk.createProject(
    applicationSpecSchema.parse({
      ...payload,
      metadata: { name: "sdk-test" },
      services: { web: { ...payload.services.web, domains: [] } },
    }),
  );
  assert.equal((await sdk.deploy(sdkProject.id)).status, "queued");
  console.log(
    "Database integration passed: migrations, login, scopes, domain uniqueness, concurrent jobs, revocation, audit.",
  );
} finally {
  await app.close();
  await db.$disconnect();
}
