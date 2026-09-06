// Operator-only acceptance probe. Runs outside the platform services being restarted.
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
const exec = promisify(execFile);
const docker = async (args: string[]) =>
  (
    await exec("/usr/bin/docker", args, {
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const fixture = JSON.parse(
  await readFile("/var/lib/hotspark/projects/acceptance-fixture.json", "utf8"),
);
const base = "http://127.0.0.1:3001/api/v1/";
let token = "";
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(base + "auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@localhost",
        password: (
          await readFile("/run/secrets/admin_password", "utf8")
        ).trim(),
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      token = (await r.json()).token;
      break;
    }
  } catch {
    /* platform restarting */
  }
  await new Promise((r) => setTimeout(r, 5000));
}
assert.ok(token, "platform available");
async function call(path: string, method = "GET", body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(r.ok, `${path}: ${r.status}`);
  return r.json();
}
async function wait(id: string, operational = false) {
  for (let i = 0; i < 120; i++) {
    const task = await call(`${operational ? "system/tasks" : "jobs"}/${id}`);
    if (task.status === "succeeded") return task;
    assert.ok(
      !["failed", "cancelled"].includes(task.status),
      `task ${id} ${task.status}`,
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
  assert.fail("task timeout");
}
async function http() {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: 80,
        path: "/",
        headers: { host: fixture.domain },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
          if (body.length > 100000) res.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy());
    req.end();
  });
}
if (process.argv[2] === "prepare") {
  await wait((await call(`projects/${fixture.siblingId}/stop`, "POST")).jobId);
  await wait(
    (
      await call(`projects/${fixture.projectId}/maintenance`, "PUT", {
        enabled: true,
      })
    ).jobId,
  );
  const current = await call(`projects/${fixture.projectId}`);
  await writeFile(
    "/var/lib/hotspark/projects/acceptance-recovery.json",
    JSON.stringify({
      ...fixture,
      activeDeploymentId: current.activeDeploymentId,
    }),
  );
  console.log(
    "PASS recovery prepared: one running/maintenance project and one intentionally stopped project",
  );
} else {
  const saved = JSON.parse(
    await readFile(
      "/var/lib/hotspark/projects/acceptance-recovery.json",
      "utf8",
    ),
  );
  let maintenance;
  for (let i = 0; i < 60; i++) {
    maintenance = await http().catch(() => undefined);
    if (
      maintenance?.status === 503 &&
      maintenance.body.includes("undergoing maintenance")
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(maintenance?.status, 503, "maintenance survived restart");
  assert.ok(
    maintenance?.body.includes("undergoing maintenance"),
    "shared maintenance page is serving",
  );
  const current = await call(`projects/${fixture.projectId}`);
  assert.equal(current.activeDeploymentId, saved.activeDeploymentId);
  assert.equal(
    (await call(`projects/${fixture.siblingId}`)).desiredState,
    "stopped",
  );
  const siblingContainers = (
    await docker([
      "ps",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=hs-${fixture.siblingId}`,
    ])
  ).trim();
  assert.equal(
    siblingContainers,
    "",
    "intentionally stopped project stays stopped",
  );
  await wait(
    (
      await call(`projects/${fixture.projectId}/maintenance`, "PUT", {
        enabled: false,
      })
    ).jobId,
  );
  let page;
  for (let i = 0; i < 30; i++) {
    page = await http().catch(() => undefined);
    if (page?.status === 200) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(page!.status, 200);
  assert.equal(JSON.parse(page!.body).marker.value, "persistent");
  console.log(
    "PASS platform/host recovery: active image, database marker, maintenance and stopped intent",
  );
  // Start sibling only after proving stopped intent; its private database is needed for the network probe.
  await wait((await call(`projects/${fixture.siblingId}/start`, "POST")).jobId);
  const own = JSON.parse(
    await readFile(
      `/var/lib/hotspark/projects/${fixture.projectId}/release-state.json`,
      "utf8",
    ),
  );
  const other = JSON.parse(
    await readFile(
      `/var/lib/hotspark/projects/${fixture.siblingId}/release-state.json`,
      "utf8",
    ),
  );
  const databaseService = other.active.plan.services.find(
    (s: { type: string }) => s.type === "postgres",
  );
  const database = JSON.parse(
    await docker([
      "inspect",
      `hs-${fixture.siblingId}-${databaseService.id}-1`,
    ]),
  )[0];
  assert.deepEqual(Object.keys(database.NetworkSettings.Networks), [
    `hs-${fixture.siblingId}_private`,
  ]);
  assert.ok(
    !Object.values(database.HostConfig.PortBindings ?? {}).length,
    "PostgreSQL has no published ports",
  );
  const address =
    database.NetworkSettings.Networks[`hs-${fixture.siblingId}_private`]
      .IPAddress;
  const web = own.active.plan.services.find(
    (s: { type: string }) => s.type !== "postgres",
  );
  const container = JSON.parse(
    await docker(["inspect", `hs-${fixture.projectId}-${web.id}-1`]),
  )[0];
  assert.equal(container.HostConfig.Privileged, false);
  assert.ok(
    container.HostConfig.Memory > 0 &&
      container.HostConfig.NanoCpus > 0 &&
      container.HostConfig.PidsLimit > 0,
  );
  assert.ok(
    !container.Mounts.some(
      (m: { Source: string; Destination: string }) =>
        m.Source.includes("docker.sock") ||
        m.Destination.includes("docker.sock"),
    ),
  );
  const nodeImage =
    "node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
  await docker([
    "run",
    "--rm",
    "--network",
    `hs-${fixture.projectId}_private`,
    nodeImage,
    "node",
    "-e",
    `const s=require('net').connect({host:${JSON.stringify(address)},port:5432});s.setTimeout(2000);s.on('connect',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(0));`,
  ]);
  console.log(
    "PASS private database unreachable cross-project, no PostgreSQL public ports, no workload Docker socket, bounded resources",
  );
  const backup = await wait(
    (await call("system/backups", "POST", { projectId: fixture.projectId }))
      .taskId,
    true,
  );
  const directory = `/var/lib/hotspark/backups/${backup.id}`;
  const manifest = JSON.parse(
    await readFile(`${directory}/manifest.json`, "utf8"),
  );
  for (const artifact of manifest.artifacts) {
    const path = `${directory}/${artifact.name}`;
    assert.equal((await stat(path)).size, artifact.bytes);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    assert.equal(hash.digest("hex"), artifact.sha256);
  }
  const dump = manifest.artifacts.find((a: { name: string }) =>
    a.name.endsWith(".dump"),
  );
  assert.ok(dump);
  const pgService = own.active.plan.services.find(
    (s: { type: string }) => s.type === "postgres",
  );
  const dbContainer = `hs-${fixture.projectId}-${pgService.id}-1`;
  const infra = JSON.parse(
    await readFile(
      `/var/lib/hotspark/projects/${fixture.projectId}/infrastructure.json`,
      "utf8",
    ),
  );
  const user = infra.services[pgService.id].environment.POSTGRES_USER;
  // Restore to a separate, temporary database; never replace the application's database.
  const restoreDb = `drill_${backup.id.replaceAll("-", "")}`;
  await docker([
    "cp",
    `${directory}/${dump.name}`,
    `${dbContainer}:/tmp/restore-drill.dump`,
  ]);
  try {
    await docker(["exec", dbContainer, "createdb", "-U", user, restoreDb]);
    await docker([
      "exec",
      dbContainer,
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
      "-U",
      user,
      "-d",
      restoreDb,
      "/tmp/restore-drill.dump",
    ]);
    assert.equal(
      await docker([
        "exec",
        dbContainer,
        "psql",
        "-U",
        user,
        "-d",
        restoreDb,
        "-Atc",
        'SELECT value FROM "Marker" WHERE id=1',
      ]),
      "persistent",
    );
  } finally {
    await docker([
      "exec",
      dbContainer,
      "dropdb",
      "-U",
      user,
      "--if-exists",
      restoreDb,
    ]);
    await docker(["exec", dbContainer, "rm", "-f", "/tmp/restore-drill.dump"]);
  }
  console.log(
    "PASS backup checksums, real logical restore and SQL marker validation",
  );
  const report = await call("system/doctor");
  assert.ok(
    report.checks.some(
      (c: { name: string; status: string }) =>
        c.name === "agent" && c.status === "ok",
    ),
  );
  assert.ok(
    report.host.checks.some(
      (c: { name: string; status: string }) =>
        c.name === "docker" && c.status === "ok",
    ),
  );
  const gc = await wait(
    (
      await call("system/garbage-collections", "POST", {
        projectId: fixture.projectId,
        retain: 2,
        dryRun: true,
      })
    ).taskId,
    true,
  );
  assert.equal(gc.result.volumesRemoved, 0);
  assert.ok(gc.result.retainedReleaseIds.includes(saved.activeDeploymentId));
  console.log("PASS authenticated doctor and conservative cleanup dry-run");
  const volumesBefore = await docker(["volume", "ls", "--quiet"]);
  const applied = await wait(
    (
      await call("system/garbage-collections", "POST", {
        projectId: fixture.projectId,
        retain: 2,
        dryRun: false,
        buildCache: true,
      })
    ).taskId,
    true,
  );
  assert.equal(applied.result.volumesRemoved, 0);
  assert.equal(await docker(["volume", "ls", "--quiet"]), volumesBefore);
  assert.equal((await http()).status, 200);
  assert.equal(
    (await call(`projects/${fixture.projectId}`)).activeDeploymentId,
    saved.activeDeploymentId,
  );
  console.log(
    "PASS owned image/cache cleanup preserves active release and every volume",
  );
  const platformBackup = await wait(
    (await call("system/backups", "POST", {})).taskId,
    true,
  );
  const platformDirectory = `/var/lib/hotspark/backups/${platformBackup.id}`;
  const platformManifest = JSON.parse(
    await readFile(`${platformDirectory}/manifest.json`, "utf8"),
  );
  assert.ok(platformManifest.artifacts.length >= 3);
  for (const artifact of platformManifest.artifacts) {
    const path = `${platformDirectory}/${artifact.name}`;
    assert.equal((await stat(path)).size, artifact.bytes);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    assert.equal(hash.digest("hex"), artifact.sha256);
  }
  console.log(
    "PASS platform database/configuration/runtime backup artifact validation",
  );
  console.log(
    "Operational acceptance passed; project backup:",
    backup.id,
    "platform backup:",
    platformBackup.id,
  );
}
