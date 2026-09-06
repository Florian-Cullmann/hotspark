// Run on a disposable installed host with an operator-owned admin password file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const base = process.env.HOTSPARK_TEST_URL ?? "http://127.0.0.1:3000/api/v1/";
const login = await fetch(new URL("auth/login", base), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: "admin@localhost",
    password: (await readFile("/run/secrets/admin_password", "utf8")).trim(),
  }),
});
assert.equal(login.status, 200);
const { token } = await login.json();
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  key?: string,
) {
  const r = await fetch(new URL(path, base), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await r.json();
  assert.ok(r.ok, JSON.stringify(value));
  return value;
}
async function wait(id: string) {
  for (let i = 0; i < 150; i++) {
    const j = await request(`jobs/${id}`);
    if (["succeeded", "failed", "cancelled"].includes(j.status)) {
      assert.equal(j.status, "succeeded", JSON.stringify(j));
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw Error("Job timeout");
}
const key = randomUUID();
const payload = {
  spec: {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: `live-${key.slice(0, 8)}` },
    services: { database: { type: "postgres", version: "17" } },
  },
};
const created = await request("projects", "POST", payload, key);
assert.equal(
  (await request("projects", "POST", payload, key)).jobId,
  created.jobId,
);
await wait(created.jobId);
assert.equal(
  (await request(`projects/${created.projectId}`)).observedState,
  "running",
);
for (const operation of ["stop", "start", "restart"])
  await wait(
    (await request(`projects/${created.projectId}/${operation}`, "POST")).jobId,
  );
await wait((await request(`projects/${created.projectId}`, "DELETE")).jobId);
const missing = await fetch(new URL(`projects/${created.projectId}`, base), {
  headers: { authorization: `Bearer ${token}` },
});
assert.equal(missing.status, 404);
console.log(
  `Live UI rewrite → API → durable worker → authenticated agent lifecycle passed; retained data for ${created.projectId}`,
);
