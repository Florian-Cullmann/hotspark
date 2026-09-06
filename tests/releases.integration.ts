// Operator-only disposable-host E2E. The sole test transport override maps one GitHub URL
// to a local Git repository; source resolution, BuildKit, PostgreSQL and Traefik are real.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
import { Runtime } from "../apps/agent/src/runtime.js";
import { ReleaseRuntime } from "../apps/agent/src/releases.js";
import { command, type CommandRunner } from "../apps/agent/src/process.js";
import { runOneJob, type AgentClient } from "../apps/api/src/worker.js";
import { secret } from "../packages/shared/src/index.js";
import { gitFetcher } from "../apps/agent/src/git.js";
import { catalog } from "../packages/providers/src/index.js";
const db = new PrismaClient(),
  root = "/var/lib/hotspark/projects",
  routes = "/var/lib/hotspark/routes",
  secrets = "/run/hotspark-secrets";
const key = await secret("SECRETS_KEY"),
  repo = await mkdtemp("/tmp/hotspark-git-");
await cp("tests/fixtures/node", repo, { recursive: true });
const original = await readFile(join(repo, "server.mjs"), "utf8");
const git = (args: string[]) => command("/usr/bin/git", ["-C", repo, ...args]);
await git(["init", "--initial-branch=main"]);
await git(["config", "user.email", "fixture@localhost"]);
await git(["config", "user.name", "Fixture"]);
const commits: string[] = [];
for (const version of ["one", "two", "broken"]) {
  await writeFile(
    join(repo, "server.mjs"),
    original
      .replace("ready: true,", `ready: true, version: "${version}",`)
      .replace(
        "res.end(\n",
        version === "broken"
          ? "res.statusCode = 500; res.end(\n"
          : "res.end(\n",
      ),
  );
  await git(["add", "."]);
  await git(["commit", "-m", version]);
  commits.push((await git(["rev-parse", "HEAD"])).trim());
}
let builds = 0;
const run: CommandRunner = async (exe, args, options) => {
  if (args[0] === "buildx") builds++;
  const mapped =
    exe === "/usr/bin/git"
      ? args.map((a) =>
          a === "protocol.file.allow=never"
            ? "protocol.file.allow=always"
            : a === "https://github.com/hotspark-fixtures/releases.git"
              ? repo
              : a,
        )
      : args;
  return command(exe, mapped, options);
};
const resolvedContext = await mkdtemp("/tmp/hotspark-ref-");
await git(["tag", "fixture", commits[1]!]);
assert.equal(
  await gitFetcher(run)(
    {
      type: "git",
      repository: "https://github.com/hotspark-fixtures/releases.git",
      tag: "fixture",
    },
    resolvedContext,
    {},
  ),
  commits[1],
);
await rm(resolvedContext, { recursive: true, force: true });
const engine = new ReleaseRuntime(
  new Runtime(
    root,
    routes,
    async (args) => run("/usr/bin/docker", args),
    false,
    key,
    secrets,
  ),
  root,
  routes,
  secrets,
  key,
  false,
  run,
);
const agent: AgentClient = (op) => engine.execute(op);
const app = await createApp(db, { secretsKey: key, agent });
const login = await app.inject({
  method: "POST",
  url: "/api/v1/auth/login",
  payload: {
    email: "admin@localhost",
    password: await secret("ADMIN_PASSWORD"),
  },
});
assert.equal(login.statusCode, 200, login.body);
const headers = { authorization: `Bearer ${login.json().token}` };
async function call(
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" = "GET",
  payload?: unknown,
) {
  const result = await app.inject({
    method,
    url: `/api/v1/${url}`,
    headers,
    ...(payload ? { payload } : {}),
  });
  assert.ok(result.statusCode < 300, `${result.statusCode}: ${result.body}`);
  return result.json();
}
async function complete(jobId: string, status = "succeeded") {
  await runOneJob(db, agent);
  const job = await call(`jobs/${jobId}`);
  assert.equal(job.status, status, JSON.stringify(job));
  return job;
}
const suffix = randomUUID().slice(0, 8),
  domain = `release-${suffix}.example.com`;
const spec = (commit: string) => ({
  apiVersion: "hotspark.dev/v1",
  kind: "Application",
  metadata: { name: `release-${suffix}` },
  deployment: { maintenance: "during-migrations" },
  services: {
    web: {
      type: "node",
      source: {
        type: "git",
        repository: "https://github.com/hotspark-fixtures/releases.git",
        commit,
        branch: "main",
      },
      runtime: {
        port: 3000,
        healthcheck: {
          type: "http",
          path: "/",
          intervalSeconds: 1,
          timeoutSeconds: 2,
          retries: 15,
        },
      },
      database: "database",
      hooks: [{ type: "prisma-migrate-deploy" }],
      domains: [domain],
    },
    database: { type: "postgres", version: "17" },
  },
});
async function http(host = domain) {
  return JSON.parse(
    await command(
      "/usr/bin/docker",
      [
        "run",
        "--rm",
        "--network",
        "hotspark-proxy",
        catalog.node["24"],
        "node",
        "-e",
        `require('http').get({hostname:'hotspark-proxy-1',port:8080,path:'/',headers:{host:${JSON.stringify(host)}}},r=>{let body='';r.on('data',c=>{body+=c;if(body.length>100000)process.exit(1)});r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,body})))})`,
      ],
      { timeout: 15000 },
    ),
  );
}
async function response(version: string | number, host = domain) {
  let last;
  for (let i = 0; i < 15; i++) {
    last = await http(host);
    if (
      typeof version === "number"
        ? last.status === version
        : last.status === 200 && JSON.parse(last.body).version === version
    )
      return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail(JSON.stringify(last));
}
let projectId = "";
try {
  const first = await call("projects", "POST", { spec: spec(commits[0]!) });
  projectId = first.projectId;
  const siblingSpec = spec(commits[0]!);
  siblingSpec.metadata.name += "-other";
  siblingSpec.services.web.domains = [`other-${domain}`];
  const sibling = await call("projects", "POST", { spec: siblingSpec });
  await Promise.all([runOneJob(db, agent), runOneJob(db, agent)]);
  assert.equal((await call(`jobs/${first.jobId}`)).status, "succeeded");
  assert.equal((await call(`jobs/${sibling.jobId}`)).status, "succeeded");
  await response("one", `other-${domain}`);
  console.log(
    "PASS different projects deploy concurrently with isolated databases",
  );
  const firstProject = await call(`projects/${projectId}`),
    firstId = firstProject.activeDeploymentId;
  assert.ok(firstId);
  const initial = JSON.parse((await response("one")).body);
  assert.equal(initial.marker.value, "persistent");
  assert.equal(initial.database, true);
  console.log("PASS initial immutable release, HTTP and database connectivity");
  const second = await call(`projects/${projectId}`, "PATCH", {
    spec: spec(commits[1]!),
  });
  const conflict = await app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/deployments`,
    headers,
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  const working = runOneJob(db, agent);
  await response("one");
  await working;
  assert.equal((await call(`jobs/${second.jobId}`)).status, "succeeded");
  await response("two");
  const secondId = (await call(`projects/${projectId}`)).activeDeploymentId;
  assert.notEqual(firstId, secondId);
  console.log(
    "PASS old traffic during build, same-project lock, healthy candidate switch",
  );
  const broken = await call(`projects/${projectId}`, "PATCH", {
    spec: spec(commits[2]!),
  });
  await complete(broken.jobId, "failed");
  await response("two");
  const afterFailure = await call(`projects/${projectId}`);
  assert.equal(afterFailure.activeDeploymentId, secondId);
  assert.equal(afterFailure.maintenanceObserved, false);
  const failed = await call(`deployments/${broken.deploymentId}`);
  assert.equal(failed.status, "failed");
  console.log(
    "PASS failed health check preserves active release and restores maintenance",
  );
  const before = builds,
    rollback = await call(`projects/${projectId}/rollbacks`, "POST", {
      deploymentId: firstId,
    });
  await complete(rollback.jobId);
  await response("one");
  assert.equal(builds, before);
  const active = (await call(`projects/${projectId}`)).activeDeploymentId;
  assert.notEqual(active, firstId);
  console.log(
    "PASS manual image rollback without rebuild or database rollback",
  );
  const maintenance = await call(`projects/${projectId}/maintenance`, "PUT", {
    enabled: true,
  });
  await complete(maintenance.jobId);
  const page = await response(503);
  assert.match(page.body, /maintenance/i);
  assert.equal((await call("health")).status, "ok");
  await response("one", `other-${domain}`);
  const off = await call(`projects/${projectId}/maintenance`, "PUT", {
    enabled: false,
  });
  await complete(off.jobId);
  await response("one");
  console.log("PASS shared maintenance page and unaffected API");
  for (const action of ["stop", "start", "restart"]) {
    const job = await call(`projects/${projectId}/${action}`, "POST");
    await complete(job.jobId);
    assert.equal(
      (await call(`projects/${projectId}`)).activeDeploymentId,
      active,
    );
  }
  await response("one");
  assert.equal(builds, before);
  console.log("PASS start/stop/restart preserve image and active deployment");
  // Crash after maintenance was persisted, before the active-pointer commit.
  const statePath = join(root, projectId, "release-state.json"),
    state = JSON.parse(await readFile(statePath, "utf8"));
  const interrupted = randomUUID(),
    operationId = randomUUID();
  state.pending = { operationId, deploymentId: interrupted };
  state.maintenance = true;
  await writeFile(statePath, JSON.stringify(state));
  const dir = join(root, projectId, "releases", interrupted);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "release.json"),
    JSON.stringify({
      id: interrupted,
      projectId,
      status: "migrating",
      previousReleaseId: active,
      sources: [],
      images: [],
      events: [],
      health: [],
      createdAt: new Date().toISOString(),
      hooks: ["started:web:migration"],
    }),
  );
  await writeFile(
    join(root, ".operations", `${operationId}.json`),
    JSON.stringify({
      id: operationId,
      hash: "fixture",
      status: "running",
      phase: "migrating",
      progress: 50,
      projectId,
      deploymentId: interrupted,
    }),
  );
  await engine.recover();
  await response("one");
  const recovered = JSON.parse(
    await readFile(join(dir, "release.json"), "utf8"),
  );
  assert.equal(recovered.status, "failed");
  assert.match(recovered.error, /uncertain/);
  assert.equal(builds, before);
  console.log("PASS interrupted migration recovery without replay");
  const detail = await call(`deployments/${active}`);
  assert.ok(
    detail.runtime.events.some((e: { phase: string }) => e.phase === "active"),
  );
  console.log(
    `Release E2E passed; project ${projectId} retained for inspection.`,
  );
} finally {
  await rm(repo, { recursive: true, force: true });
  await app.close();
  await db.$disconnect();
}
