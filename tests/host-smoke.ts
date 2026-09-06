// Run inside the API image with --network host on a disposable installed server.
import assert from "node:assert/strict";
import { get } from "node:http";
import { readFile } from "node:fs/promises";
const base = "http://127.0.0.1:3001/api/v1";
const password = (await readFile("/run/secrets/admin_password", "utf8")).trim();
const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@localhost", password }),
});
assert.equal(login.status, 200);
const { token } = (await login.json()) as { token: string };
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: body ? headers : { authorization: headers.authorization },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${path}: ${response.status} ${response.ok ? "" : await response.text()}`,
  );
  return response.json();
}
async function operate(id: string, operation: string) {
  const job = (await request(`projects/${id}/${operation}`, "POST")) as {
    id: string;
  };
  for (let i = 0; i < 180; i++) {
    const result = (await request(`jobs/${job.id}`)) as {
      status: string;
      error?: string;
    };
    if (result.status === "succeeded") return;
    if (result.status === "failed")
      throw new Error(`${operation}: ${result.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Job timed out");
}
async function route(host: string, expected: number) {
  for (let i = 0; i < 40; i++) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get("http://127.0.0.1", { headers: { host } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    if (status === expected) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Routing ${host} did not reach ${expected}`);
}
const suffix = Date.now().toString(36);
const projectIds: string[] = [];
for (const name of ["alpha", "beta"]) {
  const spec = {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: `smoke-${name}-${suffix}` },
    services: {
      web: {
        type: "web",
        source: {
          type: "image",
          image:
            "nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6",
        },
        runtime: { port: 8080 },
        domains: [`${name}-${suffix}.example.com`],
      },
      database: {
        type: "postgres",
        version: "17",
        image:
          "postgres:17@sha256:86e0b703649d7a792bd9243ee28afc9d8f7c6b2b5638077c9d6882d4d472bbfd",
      },
    },
  };
  const project = (await request("projects", "POST", spec)) as { id: string };
  projectIds.push(project.id);
  await operate(project.id, "deploy");
  await route(`${name}-${suffix}.example.com`, 200);
}
await operate(projectIds[0]!, "stop");
await route(`alpha-${suffix}.example.com`, 503);
await route(`beta-${suffix}.example.com`, 200);
await operate(projectIds[0]!, "start");
await route(`alpha-${suffix}.example.com`, 200);
assert.equal((await fetch("http://127.0.0.1:3000")).status, 200);
const uiLogin = await fetch("http://127.0.0.1:3000/api/v1/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@localhost", password }),
});
assert.equal(uiLogin.status, 200, "Next.js same-origin API rewrite");
if (process.env.HOTSPARK_TEST_GIT === "true") {
  const built = (await request("projects", "POST", {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: `smoke-build-${suffix}` },
    services: {
      web: {
        type: "web",
        source: {
          type: "git",
          repository: "https://github.com/mendhak/docker-http-https-echo.git",
          commit: "db490b6c5d7e21b1395dfebb6b46b4716544f2fa",
        },
        runtime: { port: 8080 },
        domains: [`build-${suffix}.example.com`],
      },
    },
  })) as { id: string };
  await operate(built.id, "deploy");
  await route(`build-${suffix}.example.com`, 200);
  console.log(`BuildKit Git deployment passed: ${built.id}`);
}
console.log(
  JSON.stringify({
    status: "passed",
    projectIds,
    domains: [`alpha-${suffix}.example.com`, `beta-${suffix}.example.com`],
  }),
);
