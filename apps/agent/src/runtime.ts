import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  writeFile,
  rename,
  readFile,
  chmod,
  chown,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  planDeployment,
  type DeploymentPlan,
  type AgentOperation,
} from "../../../packages/application-spec/src/index.js";
const execFileAsync = promisify(execFile);
export type Runner = (args: string[]) => Promise<string>;
export const docker: Runner = async (args) => {
  const { stdout } = await execFileAsync("/usr/bin/docker", args, {
    timeout: 840_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", DOCKER_BUILDKIT: "1", HOME: "/tmp" },
  });
  return stdout;
};
export async function atomicWrite(path: string, value: string, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, value, { mode, flag: "wx" });
  await rename(temp, path);
}
export function renderCompose(plan: DeploymentPlan, root: string) {
  const services: Record<string, unknown> = {},
    volumes: Record<string, unknown> = {},
    secrets: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(plan.spec.services)) {
    const common = {
      restart: "unless-stopped",
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
      pids_limit: 256,
      logging: {
        driver: "local",
        options: { "max-size": "10m", "max-file": "3" },
      },
      networks: ["private"],
    };
    if (s.type === "postgres") {
      volumes[`${name}-data`] = {};
      secrets[`${name}-password`] = {
        file: join(root, plan.projectId, "secrets", `${name}-password`),
      };
      services[name] = {
        ...common,
        image: s.image,
        cap_add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
        environment: {
          POSTGRES_USER: "app",
          POSTGRES_DB: "app",
          POSTGRES_PASSWORD_FILE: `/run/secrets/${name}-password`,
        },
        secrets: [`${name}-password`],
        volumes: [`${name}-data:/var/lib/postgresql/data`],
        mem_limit: "512m",
        cpus: 1,
        healthcheck: {
          test: ["CMD", "pg_isready", "-U", "app", "-d", "app"],
          interval: "10s",
          timeout: "5s",
          retries: 12,
        },
      };
    } else {
      const image =
        s.source.type === "image"
          ? s.source.image
          : plan.builds.find((b) => b.service === name)!.image;
      const alias = `${plan.composeProject}-${name}`;
      services[name] = {
        ...common,
        image,
        user: "10001:10001",
        read_only: true,
        tmpfs: ["/tmp:rw,noexec,nosuid,size=128m"],
        environment: {
          PORT: String(s.runtime.port),
          HOSTNAME: "0.0.0.0",
          NODE_ENV: "production",
        },
        mem_limit: `${s.resources.memoryMb}m`,
        cpus: s.resources.cpus,
        networks: {
          private: {},
          ...(s.domains.length ? { proxy: { aliases: [alias] } } : {}),
        },
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
      ...(Object.values(plan.spec.services).some(
        (s) => "domains" in s && s.domains.length,
      )
        ? { proxy: { external: true, name: "hotspark-proxy" } }
        : {}),
    },
  };
}
export function renderRoutes(plan: DeploymentPlan, tls: boolean) {
  const routers: Record<string, unknown> = {},
    services: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(plan.spec.services))
    if (s.type !== "postgres" && s.domains.length) {
      const id = `${plan.composeProject}-${name}`;
      routers[id] = {
        rule: s.domains.map((d) => `Host(\`${d}\`)`).join(" || "),
        entryPoints: [tls ? "websecure" : "web"],
        service: id,
        ...(tls ? { tls: { certResolver: "letsencrypt" } } : {}),
      };
      services[id] = {
        loadBalancer: {
          servers: [{ url: `http://${id}:${s.runtime.port}` }],
          healthCheck: {
            path: s.runtime.healthPath,
            interval: "10s",
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
  ) {}
  async execute(op: AgentOperation) {
    const dir = join(this.root, op.projectId);
    const file = join(dir, "compose.json");
    const args = [
      "compose",
      "--project-name",
      `hs-${op.projectId}`,
      "--file",
      file,
    ];
    if (op.operation === "deploy") {
      const plan = planDeployment(op.projectId, op.spec);
      await mkdir(join(dir, "secrets"), { recursive: true, mode: 0o700 });
      await mkdir(this.routes, { recursive: true, mode: 0o755 });
      for (const [name, s] of Object.entries(plan.spec.services))
        if (s.type === "postgres") {
          const path = join(dir, "secrets", `${name}-password`);
          try {
            await writeFile(path, randomBytes(32).toString("hex"), {
              flag: "wx",
              mode: 0o400,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          // Official postgres image uses uid 999. Only it and host root can read this file.
          await chown(path, 999, 999);
          await chmod(path, 0o400);
        }
      for (const build of plan.builds)
        await this.run([
          "buildx",
          "build",
          "--load",
          "--provenance=false",
          "--tag",
          build.image,
          `${build.repository}#${build.commit}`,
        ]);
      await atomicWrite(
        file,
        JSON.stringify(renderCompose(plan, this.root), null, 2),
      );
      await atomicWrite(
        join(dir, `${op.deploymentId}.plan.json`),
        JSON.stringify(plan, null, 2),
      );
      await this.run([
        ...args,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "180",
        "--remove-orphans",
      ]);
      await atomicWrite(
        join(this.routes, `${op.projectId}.yaml`),
        JSON.stringify(renderRoutes(plan, this.tls)),
        0o644,
      );
      await atomicWrite(
        join(dir, "current.json"),
        JSON.stringify({ deploymentId: op.deploymentId }),
      );
      return { status: "succeeded", deploymentId: op.deploymentId };
    }
    await readFile(file, "utf8"); // Missing project must fail; never operate on an implicit project.
    if (op.operation === "stop") {
      await this.run([...args, "stop", "--timeout", "30"]);
      return { status: "stopped" };
    }
    if (op.operation === "start") {
      await this.run([
        ...args,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "180",
      ]);
      return { status: "started" };
    }
    const output = await this.run([...args, "ps", "--all", "--format", "json"]);
    const rows: { Service: string; State: string; Health: string }[] = output
      .trim()
      .startsWith("[")
      ? JSON.parse(output)
      : output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
    return {
      services: rows.map((row) => ({
        name: row.Service,
        state: row.State,
        health: row.Health,
      })),
    };
  }
}
