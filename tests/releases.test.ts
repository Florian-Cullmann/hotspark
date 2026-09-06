import { it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { ReleaseRuntime } from "../apps/agent/src/releases.js";
import { Runtime } from "../apps/agent/src/runtime.js";
import {
  operationSchema,
  applicationSpecSchema,
} from "../packages/application-spec/src/index.js";
import {
  type CommandRunner,
  withProjectLock,
  command,
} from "../apps/agent/src/process.js";
import { validateContext } from "../apps/agent/src/git.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  chown: vi.fn(async () => {}),
}));
const key = "c".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hotspark-release-")),
    routes = join(root, "routes"),
    secrets = join(root, "secrets");
  const containers = new Map<string, { running: boolean; bad: boolean }>(),
    images = new Map<string, string>();
  let builds = 0;
  const run: CommandRunner = async (_exe, args, options) => {
    if (args[0] === "buildx") {
      builds++;
      const tag = args[args.indexOf("--tag") + 1]!;
      images.set(
        tag,
        `sha256:${args.some((a) => a.includes(`commit_sha=${"b".repeat(40)}`)) ? "b" : "a"}`.padEnd(
          71,
          args.some((a) => a.includes(`commit_sha=${"b".repeat(40)}`))
            ? "b"
            : "a",
        ),
      );
      await options?.onLog?.("build output\n");
      return "";
    }
    if (args[0] === "image")
      return args.includes("--format")
        ? (images.get(args.at(-1)!) ?? `sha256:${"a".repeat(64)}`)
        : "[]";
    if (args[0] === "compose") {
      const file = args[args.indexOf("--file") + 1]!,
        config = JSON.parse(await readFile(file, "utf8"));
      const service = args.at(-1)!,
        id = createHash("sha256").update(service).digest("hex");
      if (args.includes("up"))
        for (const [name, s] of Object.entries(config.services) as [
          string,
          { image: string },
        ][])
          containers.set(createHash("sha256").update(name).digest("hex"), {
            running: true,
            bad: s.image.includes("sha256:bbb"),
          });
      if (args.includes("ps")) return containers.has(id) ? id : "";
      if (args.includes("rm") || args.includes("stop"))
        for (const name of Object.keys(config.services))
          containers.delete(createHash("sha256").update(name).digest("hex"));
      return "";
    }
    if (args[0] === "inspect") {
      const container = containers.get(args[1]!);
      return JSON.stringify([
        {
          State: {
            Running: !!container,
            Status: container ? "running" : "exited",
            Health: { Status: container?.bad ? "unhealthy" : "healthy" },
          },
        },
      ]);
    }
    return "";
  };
  const engine = new ReleaseRuntime(
    new Runtime(root, routes, async () => "", false, key, secrets),
    root,
    routes,
    secrets,
    key,
    false,
    run,
    async (source, directory) => {
      await mkdir(directory, { recursive: true });
      return source.commit ?? "a".repeat(40);
    },
  );
  const projectId = randomUUID();
  const spec = (commit: string) =>
    applicationSpecSchema.parse({
      apiVersion: "hotspark.dev/v1",
      kind: "Application",
      metadata: { name: "release-test" },
      deployment: { maintenance: "entire-deployment" },
      services: {
        web: {
          type: "node",
          source: {
            type: "git",
            repository: "https://github.com/example/app.git",
            commit,
          },
          domains: ["release.example.com"],
          runtime: { healthcheck: { retries: 1, intervalSeconds: 1 } },
        },
      },
    });
  const deploy = (commit: string, rollbackOf?: string) =>
    operationSchema.parse({
      operation: "deploy",
      projectId,
      operationId: randomUUID(),
      deploymentId: randomUUID(),
      spec: spec(commit),
      ...(rollbackOf ? { rollbackOf } : {}),
    });
  return { root, routes, engine, projectId, deploy, builds: () => builds };
}
it("activates immutable candidates, preserves previous traffic on failure, rolls back without building, and toggles maintenance", async () => {
  const f = await fixture();
  try {
    const first = f.deploy("a".repeat(40));
    const a = (await f.engine.execute(first)) as { activeDeploymentId: string };
    const oldRoute = await readFile(
      join(f.routes, `${f.projectId}.yaml`),
      "utf8",
    );
    const broken = f.deploy("b".repeat(40));
    await expect(f.engine.execute(broken)).rejects.toThrow(
      "Health verification failed",
    );
    expect(await readFile(join(f.routes, `${f.projectId}.yaml`), "utf8")).toBe(
      oldRoute,
    );
    expect(
      await f.engine.execute({ operation: "inspect", projectId: f.projectId }),
    ).toMatchObject({
      activeDeploymentId: a.activeDeploymentId,
      state: "running",
      maintenance: false,
    });
    const second = (await f.engine.execute(f.deploy("c".repeat(40)))) as {
      activeDeploymentId: string;
    };
    expect(second.activeDeploymentId).not.toBe(a.activeDeploymentId);
    const count = f.builds();
    const rollback = (await f.engine.execute(
      f.deploy("a".repeat(40), a.activeDeploymentId),
    )) as { activeDeploymentId: string };
    expect(f.builds()).toBe(count);
    expect(rollback.activeDeploymentId).not.toBe(a.activeDeploymentId);
    await f.engine.execute({
      operation: "maintenance",
      operationId: randomUUID(),
      projectId: f.projectId,
      enabled: true,
    });
    expect(
      await readFile(join(f.routes, `${f.projectId}.yaml`), "utf8"),
    ).toContain("hotspark-maintenance");
    await f.engine.execute({
      operation: "maintenance",
      operationId: randomUUID(),
      projectId: f.projectId,
      enabled: false,
    });
    expect(
      await readFile(join(f.routes, `${f.projectId}.yaml`), "utf8"),
    ).not.toContain("hotspark-maintenance");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("recovers an interrupted candidate and uncertain migration without replaying its hook", async () => {
  const f = await fixture();
  try {
    const active = (await f.engine.execute(f.deploy("a".repeat(40)))) as {
      activeDeploymentId: string;
    };
    const statePath = join(f.root, f.projectId, "release-state.json"),
      state = JSON.parse(await readFile(statePath, "utf8"));
    const deploymentId = randomUUID(),
      operationId = randomUUID();
    state.pending = { operationId, deploymentId };
    state.maintenance = true;
    await writeFile(statePath, JSON.stringify(state));
    const dir = join(f.root, f.projectId, "releases", deploymentId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "release.json"),
      JSON.stringify({
        id: deploymentId,
        projectId: f.projectId,
        status: "migrating",
        previousReleaseId: active.activeDeploymentId,
        sources: [],
        images: [],
        events: [],
        health: [],
        createdAt: new Date().toISOString(),
        hooks: ["started:web"],
      }),
    );
    await writeFile(
      join(f.root, ".operations", `${operationId}.json`),
      JSON.stringify({
        id: operationId,
        hash: "test",
        status: "running",
        phase: "migrating",
        progress: 55,
        projectId: f.projectId,
        deploymentId,
      }),
    );
    const count = f.builds();
    await f.engine.recover();
    expect(f.builds()).toBe(count);
    expect(
      await f.engine.execute({ operation: "operation-status", operationId }),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Migration outcome uncertain"),
    });
    expect(
      await f.engine.execute({ operation: "inspect", projectId: f.projectId }),
    ).toMatchObject({
      state: "running",
      activeDeploymentId: active.activeDeploymentId,
      maintenance: false,
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("uses OS-backed per-project locks while allowing a different project to proceed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotspark-lock-"));
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const running = withProjectLock(join(dir, "a"), async () => {
    entered();
    await new Promise<void>((r) => {
      release = r;
    });
  });
  await ready;
  try {
    await expect(
      withProjectLock(join(dir, "a"), async () => {}),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      withProjectLock(join(dir, "b"), async () => "ok"),
    ).resolves.toBe("ok");
  } finally {
    release();
    await running;
    await rm(dir, { recursive: true, force: true });
  }
});
it("validates Git refs and rejects escaping source symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hotspark-source-"));
  try {
    await symlink("/etc/passwd", join(dir, "escape"));
    await expect(validateContext(dir)).rejects.toThrow("escapes workspace");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const bad = {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: "test" },
    services: {
      web: {
        type: "node",
        source: {
          type: "git",
          repository: "https://github.com/example/app.git",
          branch: "../main",
        },
      },
    },
  };
  expect(applicationSpecSchema.safeParse(bad).success).toBe(false);
});

it("omits empty Traefik files for projects without public domains", async () => {
  const f = await fixture();
  try {
    const op = f.deploy("a".repeat(40));
    if (op.operation !== "deploy" || op.spec.services.web?.type === "postgres")
      throw new Error("fixture");
    op.spec.services.web!.domains = [];
    await f.engine.execute(op);
    await expect(
      readFile(join(f.routes, `${f.projectId}.yaml`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("bounds command output and terminates timed-out build processes", async () => {
  const output = await command(process.execPath, [
    "-e",
    "process.stdout.write('x'.repeat(2*1024*1024))",
  ]);
  expect(Buffer.byteLength(output)).toBe(1024 * 1024);
  await expect(
    command(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 50,
    }),
  ).rejects.toThrow("Command timeout");
  const controller = new AbortController();
  controller.abort();
  await expect(
    command(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled");
});
it("restores stable database secret files after reboot and supports database-only lifecycle", async () => {
  const f = await fixture();
  try {
    const op = f.deploy("a".repeat(40));
    if (op.operation !== "deploy") throw new Error("fixture");
    op.spec = applicationSpecSchema.parse({
      apiVersion: "hotspark.dev/v1",
      kind: "Application",
      metadata: { name: "database-only" },
      services: { database: { type: "postgres", version: "17" } },
    });
    await f.engine.execute(op);
    const infra = JSON.parse(
      await readFile(join(f.root, f.projectId, "infrastructure.json"), "utf8"),
    );
    const secretFile = (Object.values(infra.secrets)[0] as { file: string })
      .file;
    await rm(secretFile);
    await f.engine.recover();
    expect((await readFile(secretFile, "utf8")).trim()).toMatch(
      /^[a-f0-9]{64}$/,
    );
    for (const operation of ["stop", "start", "restart"] as const) {
      const result = await f.engine.execute({
        operation,
        operationId: randomUUID(),
        projectId: f.projectId,
      });
      expect(result).toMatchObject({
        state: operation === "stop" ? "stopped" : "running",
      });
      if (operation === "stop")
        expect(
          await f.engine.execute({
            operation: "maintenance",
            operationId: randomUUID(),
            projectId: f.projectId,
            enabled: true,
          }),
        ).toMatchObject({ state: "stopped" });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it("finalizes a healthy committed active pointer after an interrupted traffic switch", async () => {
  const f = await fixture();
  try {
    const op = f.deploy("a".repeat(40));
    if (op.operation !== "deploy") throw new Error("fixture");
    await f.engine.execute(op);
    const statePath = join(f.root, f.projectId, "release-state.json"),
      state = JSON.parse(await readFile(statePath, "utf8"));
    state.pending = {
      operationId: op.operationId,
      deploymentId: op.deploymentId,
    };
    await writeFile(statePath, JSON.stringify(state));
    const file = join(f.root, ".operations", `${op.operationId}.json`),
      journal = JSON.parse(await readFile(file, "utf8"));
    journal.status = "running";
    journal.phase = "activating";
    delete journal.result;
    await writeFile(file, JSON.stringify(journal));
    await f.engine.recover();
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      status: "succeeded",
      result: { activeDeploymentId: op.deploymentId },
    });
    expect(f.builds()).toBe(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

it("keeps diagnostic warnings out of structured command results", async () => {
  let logs = "";
  const result = await command(
    process.execPath,
    ["-e", "console.error('warning');console.log('container-id')"],
    {
      onLog: async (value) => {
        logs = value;
      },
    },
  );
  expect(result.trim()).toBe("container-id");
  expect(logs).toContain("warning");
});
