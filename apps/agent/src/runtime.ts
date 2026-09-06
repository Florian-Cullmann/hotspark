import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  writeFile,
  rename,
  readFile,
  chmod,
  chown,
  rm,
  readdir,
  statfs,
  lstat,
  rmdir,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { totalmem, freemem, loadavg, cpus } from "node:os";
import {
  planDeployment,
  stableHash,
  type DeploymentPlan,
} from "../../../packages/providers/src/index.js";
import {
  projectIdSchema,
  type AgentOperation,
} from "../../../packages/application-spec/src/index.js";
import { seal, unseal, redact } from "../../../packages/shared/src/secrets.js";
const exec = promisify(execFile);
export type Runner = (args: string[]) => Promise<string>;
export const docker: Runner = async (args) => {
  const result = await exec("/usr/bin/docker", args, {
    timeout: 840000,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp", DOCKER_BUILDKIT: "1" },
  });
  return result.stdout;
};
export async function atomicWrite(path: string, value: string, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode, flag: "wx" });
  await rename(temp, path);
}
export interface Vault {
  databases: Record<string, { password: string; name: string; user: string }>;
  user: Record<string, Record<string, string>>;
  redactions: string[];
}
export interface Journal {
  id: string;
  hash: string;
  status: "running" | "succeeded" | "failed";
  phase: string;
  progress: number;
  result?: unknown;
  error?: string;
  hooks: string[];
}
const hardening = {
  restart: "unless-stopped",
  security_opt: ["no-new-privileges:true"],
  cap_drop: ["ALL"],
  pids_limit: 256,
  logging: { driver: "local", options: { "max-size": "10m", "max-file": "3" } },
};
export function renderCompose(plan: DeploymentPlan, secretRoot: string) {
  const services: Record<string, unknown> = {},
    volumes: Record<string, unknown> = {},
    secrets: Record<string, unknown> = {};
  for (const s of plan.services) {
    if (s.spec.type === "postgres") {
      volumes[s.volume!] = {};
      secrets[`${s.id}-password`] = {
        file: join(secretRoot, plan.projectId, `${s.id}-password`),
      };
      services[s.id] = {
        ...hardening,
        image: s.image,
        labels: { "dev.hotspark.service": s.name },
        cap_add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
        environment: {
          POSTGRES_USER: s.database!.user,
          POSTGRES_DB: s.database!.name,
          POSTGRES_PASSWORD_FILE: `/run/secrets/${s.id}-password`,
        },
        secrets: [`${s.id}-password`],
        volumes: [
          `${s.volume}:${s.spec.version === "18" ? "/var/lib/postgresql" : "/var/lib/postgresql/data"}`,
        ],
        networks: ["private"],
        mem_limit: `${s.spec.resources.memoryMb}m`,
        cpus: s.spec.resources.cpus,
        healthcheck: {
          test: [
            "CMD",
            "pg_isready",
            "-U",
            s.database!.user,
            "-d",
            s.database!.name,
          ],
          interval: "5s",
          timeout: "3s",
          retries: 30,
        },
      };
    } else {
      const managed =
        s.spec.source.type === "git" && s.type !== "web" && s.type !== "react";
      if (managed)
        secrets[`${s.id}-env`] = {
          file: join(secretRoot, plan.projectId, `${s.id}-env`),
        };
      // Escape Compose interpolation in normal configuration; values are not shell text.
      const environment = Object.fromEntries(
        Object.entries(s.spec.environment).map(([k, v]) => [
          k,
          v.replaceAll("$", () => "$$"),
        ]),
      );
      services[s.id] = {
        ...hardening,
        image: s.image,
        labels: { "dev.hotspark.service": s.name },
        user: "10001:10001",
        read_only: s.spec.runtime.readOnly,
        tmpfs: ["/tmp:rw,noexec,nosuid,size=128m"],
        environment: {
          ...environment,
          PORT: String(s.port),
          HOSTNAME: "0.0.0.0",
          NODE_ENV: "production",
          ...(managed ? { HOTSPARK_ENV_FILE: `/run/secrets/${s.id}-env` } : {}),
        },
        ...(managed ? { secrets: [`${s.id}-env`] } : {}),
        ...(s.database
          ? {
              depends_on: {
                [s.database.host]: { condition: "service_healthy" },
              },
            }
          : {}),
        mem_limit: `${s.spec.resources.memoryMb}m`,
        cpus: s.spec.resources.cpus,
        networks: {
          private: {},
          ...(s.spec.domains.length ? { proxy: { aliases: [s.alias] } } : {}),
        },
        ...(managed
          ? {
              healthcheck: {
                test: [
                  "CMD",
                  "node",
                  "-e",
                  `require('http').get('http://127.0.0.1:${s.port}${s.spec.runtime.healthPath}',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))`,
                ],
                interval: "5s",
                timeout: "3s",
                retries: 30,
                start_period: "15s",
              },
            }
          : {}),
      };
    }
  }
  return {
    name: plan.composeProject,
    services,
    volumes,
    secrets,
    networks: {
      private: { driver: "bridge" },
      ...(plan.services.some(
        (s) => s.spec.type !== "postgres" && s.spec.domains.length,
      )
        ? { proxy: { external: true, name: "hotspark-proxy" } }
        : {}),
    },
  };
}
export function renderRoutes(plan: DeploymentPlan, tls: boolean) {
  const routers: Record<string, unknown> = {},
    services: Record<string, unknown> = {};
  for (const s of plan.services)
    if (s.spec.type !== "postgres" && s.spec.domains.length) {
      routers[s.alias] = {
        rule: s.spec.domains.map((d) => `Host(\`${d}\`)`).join(" || "),
        entryPoints: [tls ? "websecure" : "web"],
        service: s.alias,
        ...(tls ? { tls: { certResolver: "letsencrypt" } } : {}),
      };
      services[s.alias] = {
        loadBalancer: {
          servers: [{ url: `http://${s.alias}:${s.port}` }],
          healthCheck: {
            path: s.spec.runtime.healthcheck?.path ?? s.spec.runtime.healthPath,
            interval: "5s",
            timeout: "3s",
          },
        },
      };
    }
  return { http: { routers, services } };
}
export class Runtime {
  constructor(
    private readonly root: string,
    private readonly routes: string,
    private readonly run: Runner = docker,
    private readonly tls = false,
    private readonly key: string,
    private readonly secretRoot = "/run/hotspark-secrets",
  ) {
    if (!/^[a-f0-9]{64}$/.test(key))
      throw new Error("A 256-bit encryption key is required");
  }
  private async read<T>(path: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async vault(projectId: string): Promise<Vault> {
    try {
      return unseal<Vault>(
        await readFile(join(this.root, projectId, "vault.enc"), "utf8"),
        this.key,
        `vault:${projectId}`,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { databases: {}, user: {}, redactions: [] };
      throw e;
    }
  }
  private async secretFile(path: string, data: string, uid: number) {
    try {
      if ((await lstat(path)).isDirectory()) await rmdir(path);
      else await rm(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await atomicWrite(path, data, 0o400);
    await chown(path, uid, uid);
    await chmod(path, 0o400);
  }
  async materialize(
    plan: DeploymentPlan,
    vault: Vault,
    secretRoot = this.secretRoot,
  ) {
    const dir = join(secretRoot, plan.projectId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const s of plan.services) {
      if (s.type === "postgres") {
        await this.secretFile(
          join(dir, `${s.id}-password`),
          vault.databases[s.id]!.password,
          999,
        );
      } else if (
        s.spec.type !== "postgres" &&
        s.spec.source.type === "git" &&
        !["react", "web"].includes(s.type)
      ) {
        const env = { ...vault.user[s.name] };
        if (s.database) {
          const db = vault.databases[s.database.host]!;
          env.DATABASE_URL = `postgresql://${db.user}:${encodeURIComponent(db.password)}@${s.database.host}:5432/${db.name}`;
        }
        await this.secretFile(
          join(dir, `${s.id}-env`),
          JSON.stringify(env),
          10001,
        );
      }
    }
  }
  async restoreSecrets() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.root)) {
      if (!projectIdSchema.safeParse(id).success) continue;
      const plan = await this.read<DeploymentPlan>(
        join(this.root, id, "plan.json"),
      );
      const removed = await this.read(join(this.root, id, "removed.json"));
      if (plan && !removed) await this.materialize(plan, await this.vault(id));
    }
  }
  private journalPath(id: string) {
    return join(this.root, ".operations", `${id}.json`);
  }
  async status(id: string) {
    return await this.read<Journal>(this.journalPath(id));
  }
  async execute(op: AgentOperation): Promise<unknown> {
    if (
      op.operation === "project-usage" ||
      op.operation === "diagnostics" ||
      op.operation === "system-task-status" ||
      op.operation === "backup" ||
      op.operation === "garbage-collect" ||
      op.operation === "platform-update"
    )
      throw new Error("Operational dispatcher required");
    if (op.operation === "operation-status") return this.status(op.operationId);
    if (op.operation === "host-info") {
      const disk = await statfs(this.root);
      return {
        memory: { total: totalmem(), free: freemem() },
        cpu: { count: cpus().length, load: loadavg() },
        disk: {
          total: disk.blocks * disk.bsize,
          available: disk.bavail * disk.bsize,
        },
      };
    }
    if (
      op.operation === "maintenance" ||
      op.operation === "cancel-deployment" ||
      op.operation === "deployment-details"
    )
      throw new Error("Unsupported operation");
    const dir = join(this.root, op.projectId),
      file = join(dir, "compose.json"),
      args = [
        "compose",
        "--project-name",
        `hs-${op.projectId}`,
        "--file",
        file,
      ];
    if (op.operation === "inspect") {
      try {
        await readFile(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          return { state: "created", services: [] };
        throw e;
      }
      const output = await this.run([
        ...args,
        "ps",
        "--all",
        "--format",
        "json",
      ]);
      const rows: { Service: string; State: string; Health?: string }[] = output
        .trim()
        .startsWith("[")
        ? JSON.parse(output)
        : output
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((s) => JSON.parse(s));
      const plan = await this.read<DeploymentPlan>(join(dir, "plan.json"));
      const services = rows.map((s) => ({
        name: plan?.services.find((p) => p.id === s.Service)?.name ?? s.Service,
        state: s.State,
        health: s.Health ?? "",
      }));
      const expected = plan?.services.length ?? services.length;
      const state =
        services.length === 0
          ? "stopped"
          : services.every((s) => s.state === "exited" || s.state === "created")
            ? "stopped"
            : services.length === expected &&
                services.every(
                  (s) =>
                    s.state === "running" &&
                    s.health !== "unhealthy" &&
                    s.health !== "starting",
                )
              ? "running"
              : "degraded";
      return { state, services };
    }
    if (op.operation === "logs") {
      const plan = await this.read<DeploymentPlan>(join(dir, "plan.json"));
      const id =
        plan?.services.find((s) => s.name === op.service)?.id ?? op.service;
      const compose = JSON.parse(await readFile(file, "utf8")) as {
        services: Record<string, unknown>;
      };
      if (!Object.hasOwn(compose.services, id))
        throw new Error("Unknown service");
      const output = await this.run([...args, "ps", "--all", "--quiet", id]);
      const containers = output.trim().split("\n").filter(Boolean);
      let data = "";
      for (const container of containers.slice(0, 4)) {
        if (!/^[a-f0-9]{12,64}$/.test(container))
          throw new Error("Invalid runtime container ID");
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            "/usr/bin/docker",
            ["logs", "--tail", String(op.lines), "--timestamps", container],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let tail = Buffer.alloc(0);
          const collect = (chunk: Buffer) => {
            tail = Buffer.concat([tail, chunk]).subarray(-256 * 1024);
          };
          child.stdout.on("data", (chunk: Buffer) => {
            if (op.stream !== "stderr") collect(chunk);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            if (op.stream !== "stdout") collect(chunk);
          });
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Log retrieval timed out"));
          }, 10000);
          child.on("error", () => {
            clearTimeout(timer);
            reject(new Error("Log retrieval failed"));
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(tail.toString("utf8"));
            else reject(new Error("Log retrieval failed"));
          });
        });
        data = Buffer.from(data + output)
          .subarray(-256 * 1024)
          .toString("utf8");
      }
      const vault = await this.vault(op.projectId);
      return {
        service: op.service,
        stream: op.stream,
        text: Buffer.from(
          redact(data, [
            ...vault.redactions,
            ...Object.values(vault.databases).map((d) => d.password),
            ...Object.values(vault.user).flatMap(Object.values),
          ]),
        )
          .subarray(-256 * 1024)
          .toString("utf8"),
        maxBytes: 256 * 1024,
      };
    }
    await mkdir(join(this.root, ".operations"), {
      recursive: true,
      mode: 0o700,
    });
    const hash = stableHash(op);
    let journal = await this.status(op.operationId);
    if (journal && journal.hash !== hash)
      throw new Error("Operation ID reused");
    if (journal?.status === "succeeded") return journal.result;
    if (journal?.phase.startsWith("hook-running:"))
      throw new Error(
        "Migration result is uncertain; operator reconciliation required",
      );
    if (journal?.status === "failed")
      throw new Error(journal.error ?? "Previous attempt failed");
    journal ??= {
      id: op.operationId,
      hash,
      status: "running",
      phase: "provisioning",
      progress: 5,
      hooks: [],
    };
    const checkpoint = async (phase: string, progress: number) => {
      journal.phase = phase;
      journal.progress = progress;
      await atomicWrite(
        this.journalPath(op.operationId),
        JSON.stringify(journal),
      );
    };
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await checkpoint("provisioning", 5);
      let result: unknown;
      if (op.operation === "deploy") {
        const plan = planDeployment(op.projectId, op.spec);
        const existing = await this.read<DeploymentPlan>(
          join(dir, "plan.json"),
        );
        if (!existing) {
          try {
            await readFile(file);
            throw new Error("Legacy project requires explicit migration");
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
        const vault = await this.vault(op.projectId);
        if (op.encryptedSecrets) {
          vault.redactions = [
            ...new Set([
              ...vault.redactions,
              ...Object.values(vault.user).flatMap(Object.values),
            ]),
          ].slice(-500);
          vault.user = unseal(
            op.encryptedSecrets,
            this.key,
            `project:${op.projectId}`,
          );
        }
        for (const s of plan.services)
          if (s.type === "postgres" && !vault.databases[s.id])
            vault.databases[s.id] = {
              password: randomBytes(32).toString("hex"),
              name: s.database!.name,
              user: s.database!.user,
            };
        for (const s of plan.services)
          if (s.spec.type !== "postgres")
            for (const k of s.spec.secrets)
              if (!vault.user[s.name]?.[k])
                throw new Error("Missing declared secret");
        await atomicWrite(
          join(dir, "vault.enc"),
          seal(vault, this.key, `vault:${op.projectId}`),
        );
        await atomicWrite(
          join(dir, "plan.json"),
          JSON.stringify(plan, null, 2),
        );
        await this.materialize(plan, vault);
        await checkpoint("building", 20);
        for (const build of plan.builds) {
          const context = join(dir, "builds", build.id);
          await mkdir(context, { recursive: true, mode: 0o700 });
          const buildArgs = [
            "buildx",
            "build",
            "--load",
            "--provenance=false",
            "--tag",
            build.image,
          ];
          if (build.dockerfile) {
            await atomicWrite(join(context, "Dockerfile"), build.dockerfile);
            for (const [name, data] of Object.entries(build.files))
              await atomicWrite(join(context, name), data, 0o644);
            await this.run([
              ...buildArgs,
              "--build-context",
              `source=${build.repository}#${build.commit}`,
              "--file",
              join(context, "Dockerfile"),
              context,
            ]);
          } else
            await this.run([
              ...buildArgs,
              `${build.repository}#${build.commit}`,
            ]);
          const actual = await this.run([
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            build.image,
          ]);
          const s = plan.services.find((s) => s.id === build.id)!;
          if (/^sha256:[a-f0-9]{64}$/.test(actual.trim()))
            s.image = actual.trim();
        }
        await atomicWrite(
          file,
          JSON.stringify(renderCompose(plan, this.secretRoot), null, 2),
        );
        await atomicWrite(
          join(dir, `${op.deploymentId}.plan.json`),
          JSON.stringify(plan, null, 2),
        );
        await atomicWrite(
          join(dir, "plan.json"),
          JSON.stringify(plan, null, 2),
        );
        const dbs = plan.services
          .filter((s) => s.type === "postgres")
          .map((s) => s.id);
        if (dbs.length)
          await this.run([
            ...args,
            "up",
            "--detach",
            "--wait",
            "--wait-timeout",
            "180",
            ...dbs,
          ]);
        for (const s of plan.services)
          if (
            s.spec.type !== "postgres" &&
            s.spec.hooks.length &&
            !journal.hooks.includes(s.id)
          ) {
            await checkpoint(`hook-running:${s.id}`, 65);
            await this.run([
              ...args,
              "run",
              "--rm",
              "--no-deps",
              "--entrypoint",
              "node",
              s.id,
              "/opt/hotspark/loader.mjs",
              "--migrate",
            ]);
            journal.hooks.push(s.id);
            await checkpoint("hook-complete", 75);
          }
        await checkpoint("starting", 80);
        await this.run([
          ...args,
          "up",
          "--detach",
          "--wait",
          "--wait-timeout",
          "180",
          "--remove-orphans",
          "--force-recreate",
        ]);
        await mkdir(this.routes, { recursive: true, mode: 0o755 });
        await atomicWrite(
          join(this.routes, `${op.projectId}.yaml`),
          JSON.stringify(renderRoutes(plan, this.tls)),
          0o644,
        );
        await atomicWrite(
          join(dir, "current.json"),
          JSON.stringify({
            deploymentId: op.deploymentId,
            specHash: plan.specHash,
          }),
        );
        await rm(join(dir, "removed.json"), { force: true });
        result = { state: "running", deploymentId: op.deploymentId };
      } else if (op.operation === "remove") {
        await rm(join(this.routes, `${op.projectId}.yaml`), { force: true });
        try {
          await readFile(file);
          await this.run([...args, "down", "--remove-orphans"]);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        await atomicWrite(
          join(dir, "removed.json"),
          JSON.stringify({ operationId: op.operationId }),
        );
        await rm(join(this.secretRoot, op.projectId), {
          recursive: true,
          force: true,
        });
        result = { state: "deleted", dataRetained: true };
      } else {
        await readFile(file);
        const plan = await this.read<DeploymentPlan>(join(dir, "plan.json"));
        if (plan) await this.materialize(plan, await this.vault(op.projectId));
        if (op.operation === "stop")
          await this.run([...args, "stop", "--timeout", "30"]);
        else {
          if (op.operation === "restart")
            await this.run([...args, "stop", "--timeout", "30"]);
          await this.run([
            ...args,
            "up",
            "--detach",
            "--wait",
            "--wait-timeout",
            "180",
          ]);
        }
        result = { state: op.operation === "stop" ? "stopped" : "running" };
      }
      journal.status = "succeeded";
      journal.result = result;
      await checkpoint("complete", 100);
      return result;
    } catch {
      journal.status = "failed";
      journal.error = journal.phase.startsWith("hook-running:")
        ? "Migration failed or uncertain; manual reconciliation required"
        : `Operation failed during ${journal.phase}`;
      await atomicWrite(
        this.journalPath(op.operationId),
        JSON.stringify(journal),
      );
      throw new Error(journal.error);
    }
  }
}
