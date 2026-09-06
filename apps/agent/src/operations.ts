import { builderName } from "./buildkit.js";
import { mkdir, readFile, readdir, rm, stat, statfs } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, X509Certificate } from "node:crypto";
import { join } from "node:path";
import { Resolver } from "node:dns/promises";
import { cpus, freemem, totalmem, loadavg } from "node:os";
import {
  type AgentOperation,
  projectIdSchema,
} from "../../../packages/application-spec/src/index.js";
import {
  labelPrefix,
  stableHash,
} from "../../../packages/providers/src/index.js";
import { atomicWrite } from "./runtime.js";
import { command, withProjectLock, type CommandRunner } from "./process.js";
import type { ReleaseRecord, ActiveRelease } from "./releases.js";

type TaskOperation = Extract<AgentOperation, { taskId: string }>;
interface TaskJournal {
  status: "running" | "succeeded" | "failed";
  hash: string;
  result?: unknown;
  error?: string;
}
export async function checksum(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export function retainedReleases(
  records: ReleaseRecord[],
  active: string | undefined,
  previous: string | undefined,
  retain: number,
) {
  return new Set(
    [
      active,
      previous,
      ...records
        .filter((r) =>
          ["active", "superseded", "rolled_back"].includes(r.status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, retain)
        .map((r) => r.id),
    ].filter((id): id is string => !!id),
  );
}
async function json<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export class Operations {
  constructor(
    private readonly runtime: { execute(op: AgentOperation): Promise<unknown> },
    private readonly root = "/var/lib/hotspark",
    private readonly run: CommandRunner = command,
  ) {}
  private journal(id: string) {
    projectIdSchema.parse(id);
    return join(this.root, "operations", `${id}.json`);
  }
  async execute(op: AgentOperation): Promise<unknown> {
    if (op.operation === "diagnostics") return this.diagnostics();
    if (op.operation === "project-usage") {
      const ids = (
        await this.docker([
          "ps",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=hs-${op.projectId}`,
        ])
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const stats = !ids.length
        ? []
        : (
            await this.docker(
              ["stats", "--no-stream", "--format", "{{json .}}", ...ids],
              15000,
            )
          )
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const r = JSON.parse(line);
              return {
                id: r.ID,
                cpu: r.CPUPerc,
                memory: r.MemUsage,
                processes: r.PIDs,
                network: r.NetIO,
                blockIO: r.BlockIO,
              };
            });
      const volumes = await this.volumeUsage()
        .then((rows) =>
          rows.filter((v) => v.name.startsWith(`hs-${op.projectId}_`)),
        )
        .catch(() => null);
      return { containers: stats, volumes, storageQuota: false };
    }
    if (op.operation === "system-task-status")
      return json<TaskJournal>(this.journal(op.taskId));
    if (
      op.operation !== "backup" &&
      op.operation !== "garbage-collect" &&
      op.operation !== "platform-update"
    )
      return this.runtime.execute(op);
    await mkdir(join(this.root, "operations"), {
      recursive: true,
      mode: 0o700,
    });
    return withProjectLock(join(this.root, "operations", ".lock"), async () => {
      const old = await json<TaskJournal>(this.journal(op.taskId));
      if (old && old.hash !== stableHash(op)) throw new Error("Task ID reused");
      if (old?.status === "succeeded") return old.result;
      if (old?.status === "failed")
        throw new Error("Task previously failed; submit a new task");
      // A Docker exec dump may outlive the agent. Never overwrite its temporary file after a crash.
      if (old?.status === "running" && op.operation === "backup") {
        await atomicWrite(
          this.journal(op.taskId),
          JSON.stringify({
            status: "failed",
            hash: stableHash(op),
            error:
              "Backup interrupted; inspect partial artifacts and submit a new task",
          }),
        );
        throw new Error("Interrupted backup requires a new task");
      }
      // Conservative GC can resume under the same persistent locks.
      if (op.operation === "platform-update") return this.update(op, old);
      const work = async () => {
        await atomicWrite(
          this.journal(op.taskId),
          JSON.stringify({ status: "running", hash: stableHash(op) }),
        );
        try {
          const result =
            op.operation === "backup"
              ? await this.backup(op)
              : await this.gc(op);
          await atomicWrite(
            this.journal(op.taskId),
            JSON.stringify({
              status: "succeeded",
              hash: stableHash(op),
              result,
            }),
          );
          return result;
        } catch {
          await atomicWrite(
            this.journal(op.taskId),
            JSON.stringify({
              status: "failed",
              hash: stableHash(op),
              error:
                "Operation failed; partial artifacts are not valid backups",
            }),
          );
          throw new Error("Operational task failed");
        }
      };
      return op.projectId
        ? withProjectLock(
            join(this.root, "projects", ".locks", op.projectId),
            work,
          )
        : work();
    });
  }
  private async docker(args: string[], timeout = 30000) {
    return this.run("/usr/bin/docker", args, { timeout });
  }
  private async volumeUsage() {
    const rows = await this.docker([
      "system",
      "df",
      "--verbose",
      "--format",
      "{{range .Volumes}}{{.Name}}\t{{.Size}}\n{{end}}",
    ]);
    return rows
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, size] = line.split("\t");
        return { name: name!, size: size ?? "unknown" };
      });
  }
  async diagnostics() {
    const checks: {
      name: string;
      status: "ok" | "warning" | "error" | "unknown";
      detail: string;
    }[] = [];
    const disk = await statfs(this.root);
    const available = disk.bavail * disk.bsize,
      total = disk.blocks * disk.bsize;
    checks.push({
      name: "disk",
      status:
        available / total < 0.15 || available < 2 * 2 ** 30 ? "warning" : "ok",
      detail: `${available} bytes available of ${total}`,
    });
    let dockerVersion: string | null = null;
    try {
      dockerVersion = (
        await this.docker(["version", "--format", "{{.Server.Version}}"])
      ).trim();
      checks.push({ name: "docker", status: "ok", detail: dockerVersion });
    } catch {
      checks.push({
        name: "docker",
        status: "error",
        detail: "Docker daemon unavailable",
      });
    }
    const containers: { service: string; running: boolean; health: string }[] =
      [];
    try {
      const ids = (
        await this.docker([
          "ps",
          "--all",
          "--quiet",
          "--filter",
          "label=com.docker.compose.project=hotspark",
        ])
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids.slice(0, 20)) {
        const result = JSON.parse(
          await this.docker(["inspect", "--format", "{{json .State}}", id]),
        );
        const service = (
          await this.docker([
            "inspect",
            "--format",
            '{{index .Config.Labels "com.docker.compose.service"}}',
            id,
          ])
        ).trim();
        if (
          ["api", "agent", "web", "database", "proxy", "maintenance"].includes(
            service,
          )
        )
          containers.push({
            service,
            running: result.Running === true,
            health: result.Health?.Status ?? "unknown",
          });
      }
      for (const service of [
        "api",
        "agent",
        "web",
        "database",
        "proxy",
        "maintenance",
      ]) {
        const c = containers.find((c) => c.service === service);
        checks.push({
          name: service,
          status: c?.running && c.health === "healthy" ? "ok" : "error",
          detail: c
            ? `${c.running ? "running" : "stopped"}; ${c.health}`
            : "Container missing",
        });
      }
    } catch {
      checks.push({
        name: "containers",
        status: "error",
        detail: "Container inspection unavailable",
      });
    }
    try {
      await this.docker([
        "network",
        "inspect",
        "hotspark-proxy",
        "--format",
        "{{.Driver}}",
      ]);
      checks.push({
        name: "networking",
        status: "ok",
        detail: "Proxy bridge exists; project isolation is tested separately",
      });
    } catch {
      checks.push({
        name: "networking",
        status: "error",
        detail: "Proxy bridge unavailable",
      });
    }
    const resolver = new Resolver({ timeout: 2000, tries: 1 });
    try {
      await resolver.resolve4("github.com");
      checks.push({
        name: "dns",
        status: "ok",
        detail: "Public source DNS resolution succeeded",
      });
    } catch {
      checks.push({
        name: "dns",
        status: "warning",
        detail: "Public source DNS resolution failed",
      });
    }
    let certificates: { count: number; expiring: number } | null = null;
    try {
      const acme = await json<
        Record<string, { Certificates?: { certificate: string }[] }>
      >(join(this.root, "acme", "acme.json"));
      if (acme) {
        const certs = Object.values(acme).flatMap((a) => a.Certificates ?? []);
        certificates = {
          count: certs.length,
          expiring: certs.filter(
            (c) =>
              Date.parse(
                new X509Certificate(Buffer.from(c.certificate, "base64"))
                  .validTo,
              ) <
              Date.now() + 14 * 86400000,
          ).length,
        };
      }
    } catch {
      /* Never expose ACME account keys, certificate subjects or raw file errors. */
    }
    checks.push({
      name: "certificates",
      status: certificates
        ? certificates.expiring
          ? "warning"
          : "ok"
        : "unknown",
      detail: certificates
        ? `${certificates.count} certificates; ${certificates.expiring} expire within 14 days`
        : "No readable ACME certificate state",
    });
    let storage: unknown = null;
    try {
      storage = (await this.docker(["system", "df", "--format", "{{json .}}"]))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const r = JSON.parse(line);
          return { type: r.Type, size: r.Size, reclaimable: r.Reclaimable };
        });
    } catch {
      /* check remains partial */
    }
    let temporaryBytes: number | null = 0;
    try {
      for (const id of (await readdir(join(this.root, "projects"))).filter(
        (id) => projectIdSchema.safeParse(id).success,
      )) {
        const dir = join(this.root, "projects", id, "workspaces");
        if (await stat(dir).catch(() => null))
          temporaryBytes += Number(
            (
              await this.run("/usr/bin/du", ["-sb", dir], { timeout: 5000 })
            ).split(/\s/)[0],
          );
      }
    } catch {
      temporaryBytes = null;
    }
    const volumeUsage = await this.volumeUsage().catch(() => null);
    const projectVolumes = volumeUsage
      ?.filter((v) => v.name.startsWith("hs-"))
      .map((v) => ({ size: v.size }));
    const builderCache =
      volumeUsage?.find(
        (v) => v.name === `buildx_buildkit_${builderName}0_state`,
      )?.size ?? null;
    return {
      projectVolumes: projectVolumes ?? null,
      builderCache,
      version: 1,
      checkedAt: new Date().toISOString(),
      checks,
      dockerVersion,
      memory: { total: totalmem(), free: freemem() },
      cpu: { count: cpus().length, load: loadavg() },
      disk: { total, available },
      storage,
      temporaryBytes,
      certificates,
    };
  }
  private async backup(op: Extract<TaskOperation, { operation: "backup" }>) {
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize < 2 * 2 ** 30)
      throw new Error("Insufficient backup space");
    const directory = join(this.root, "backups", op.taskId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const artifacts: {
      name: string;
      bytes: number;
      sha256: string;
      validation: string;
    }[] = [];
    const add = async (name: string, validation: string) => {
      const path = join(directory, name),
        bytes = (await stat(path)).size;
      if (!bytes) throw new Error("Empty backup artifact");
      artifacts.push({ name, bytes, sha256: await checksum(path), validation });
    };
    const targets: {
      container: string;
      user: string;
      database: string;
      file: string;
    }[] = [];
    if (op.projectId) {
      const state = await json<{ active: ActiveRelease | null }>(
        join(this.root, "projects", op.projectId, "release-state.json"),
      );
      if (!state?.active)
        throw new Error("Backup requires an active release record");
      for (const service of state.active.plan.services.filter(
        (s) => s.type === "postgres",
      )) {
        // Generated database identity is taken from the agent-owned vault, not public input.
        const compose = await json<{
          services: Record<string, { environment: Record<string, string> }>;
        }>(join(this.root, "projects", op.projectId, "infrastructure.json"));
        const env = compose?.services[service.id]?.environment;
        if (!env?.POSTGRES_USER || !env.POSTGRES_DB)
          throw new Error("Database identity unavailable");
        targets.push({
          container: `hs-${op.projectId}-${service.id}-1`,
          user: env.POSTGRES_USER,
          database: env.POSTGRES_DB,
          file: `${service.id}.dump`,
        });
      }
    } else
      targets.push({
        container: "hotspark-database-1",
        user: "hotspark",
        database: "hotspark",
        file: "platform.dump",
      });
    for (const target of targets) {
      const temp = `/tmp/hotspark-backup-${op.taskId}.dump`;
      try {
        await this.docker(
          [
            "exec",
            target.container,
            "pg_dump",
            "--format=custom",
            "--no-owner",
            "--no-acl",
            "--username",
            target.user,
            "--dbname",
            target.database,
            "--file",
            temp,
          ],
          900000,
        );
        await this.docker([
          "exec",
          target.container,
          "pg_restore",
          "--list",
          temp,
        ]);
        await this.docker(
          ["cp", `${target.container}:${temp}`, join(directory, target.file)],
          900000,
        );
        await add(
          target.file,
          "pg_dump exit 0; pg_restore --list exit 0; SHA-256 (restore drill still required)",
        );
      } finally {
        await this.docker(["exec", target.container, "rm", "-f", temp]).catch(
          () => {},
        );
      }
    }
    const archive = async (name: string, base: string, paths: string[]) => {
      await this.run(
        "/usr/bin/tar",
        [
          "--exclude=workspaces",
          "--exclude=logs.txt",
          "-czf",
          join(directory, name),
          "-C",
          base,
          ...paths,
        ],
        { timeout: 900000 },
      );
      await this.run("/usr/bin/tar", ["-tzf", join(directory, name)], {
        timeout: 30000,
      });
      await add(name, "tar listing verified; SHA-256");
    };
    if (op.projectId)
      await archive("project-metadata.tar.gz", join(this.root, "projects"), [
        op.projectId,
      ]);
    else {
      await archive("configuration.tar.gz", "/etc/hotspark", ["."]);
      await archive("runtime-metadata.tar.gz", this.root, [
        "projects",
        "routes",
        "acme",
      ]);
    }
    const manifest = {
      version: 1,
      id: op.taskId,
      kind: op.projectId ? "project" : "platform",
      projectId: op.projectId ?? null,
      createdAt: new Date().toISOString(),
      artifacts,
      volumeStrategy: "postgres-logical",
      encrypted: false,
      consistency:
        "Each PostgreSQL dump is transactionally consistent; metadata files and multiple databases are not a global snapshot",
      excludes: ["workload images", "build cache", "non-PostgreSQL volumes"],
    };
    await atomicWrite(
      join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    return manifest;
  }
  private async gc(
    op: Extract<TaskOperation, { operation: "garbage-collect" }>,
  ) {
    const dir = join(this.root, "projects", op.projectId),
      state = await json<{
        active: ActiveRelease | null;
        previous: ActiveRelease | null;
        pending?: unknown;
      }>(join(dir, "release-state.json"));
    if (!state || state.pending)
      throw new Error("Project state unavailable or deployment pending");
    const records: ReleaseRecord[] = [];
    for (const id of await readdir(join(dir, "releases"))) {
      if (!projectIdSchema.safeParse(id).success) continue;
      const record = await json<ReleaseRecord>(
        join(dir, "releases", id, "release.json"),
      );
      if (record) records.push(record);
    }
    const keep = retainedReleases(
      records,
      state.active?.id,
      state.previous?.id,
      op.retain,
    );
    const protectedImages = new Set<string>();
    for (const r of records.filter((r) => keep.has(r.id))) {
      for (const image of r.images) protectedImages.add(image.digest);
      for (const service of r.plan?.services ?? [])
        for (const ref of [service.image, service.migrationImage].filter(
          (s): s is string => !!s,
        )) {
          try {
            protectedImages.add(
              (
                await this.docker([
                  "image",
                  "inspect",
                  "--format",
                  "{{.Id}}",
                  ref,
                ])
              ).trim(),
            );
          } catch {
            throw new Error(
              "Retained release image unavailable; refuse cleanup",
            );
          }
        }
    }
    const candidates = (
      await this.docker([
        "image",
        "ls",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=${labelPrefix}.project_id=${op.projectId}`,
      ])
    )
      .trim()
      .split(/\s+/)
      .filter((id) => /^sha256:[a-f0-9]{64}$/.test(id));
    const images: string[] = [];
    for (const id of new Set(candidates)) {
      if (protectedImages.has(id)) continue;
      const users = (
        await this.docker([
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `ancestor=${id}`,
        ])
      ).trim();
      if (users) continue;
      images.push(id);
      if (!op.dryRun) await this.docker(["image", "rm", id]); // No --force; Docker rechecks references.
    }
    let buildCache = "Not requested; shared daemon cache is never pruned";
    if (op.buildCache) {
      const owner = await readFile(
        join(this.root, "buildkit", "owner"),
        "utf8",
      );
      if (owner !== builderName)
        throw new Error("Builder ownership not established");
      if (!op.dryRun)
        await this.docker(
          [
            "buildx",
            "prune",
            "--builder",
            builderName,
            "--filter",
            "until=168h",
            "--reserved-space",
            "2GB",
            "--max-used-space",
            "10GB",
            "--force",
          ],
          120000,
        );
      buildCache = op.dryRun
        ? "Would prune unused platform-builder cache older than seven days, retaining at least 2 GB"
        : "Pruned unused platform-builder cache older than seven days";
    }
    if (!op.dryRun) {
      await rm(join(dir, "workspaces"), { recursive: true, force: true });
      for (const record of records)
        if (!keep.has(record.id))
          await rm(join(dir, "releases", record.id, "logs.txt"), {
            force: true,
          });
    }
    return {
      dryRun: op.dryRun,
      retainedReleaseIds: [...keep],
      images,
      volumesRemoved: 0,
      buildCache,
      releaseMetadata:
        "Preserved for audit; images removed by GC may no longer support rollback",
    };
  }
  private async update(
    _op: Extract<TaskOperation, { operation: "platform-update" }>,
    _old: TaskJournal | null,
  ): Promise<unknown> {
    const op = _op;
    const name = `hotspark-update-${op.taskId}`;
    if (_old?.status === "running") {
      const running = await this.docker([
        "inspect",
        "--format",
        "{{.State.Running}}",
        name,
      ]).catch(() => "false");
      if (running.trim() === "true") return { status: "running" };
      await atomicWrite(
        this.journal(op.taskId),
        JSON.stringify({
          status: "failed",
          hash: stableHash(op),
          error:
            "Update runner interrupted; review migration state before another update",
        }),
      );
      throw new Error("Interrupted update requires review");
    }
    // Also fence orphaned runtime work: PostgreSQL alone cannot prove the agent is idle.
    for (const project of (await readdir(join(this.root, "projects"))).filter(
      (id) => projectIdSchema.safeParse(id).success,
    )) {
      await withProjectLock(
        join(this.root, "projects", ".locks", project),
        async () => {
          const state = await json<{ pending?: unknown }>(
            join(this.root, "projects", project, "release-state.json"),
          );
          if (state?.pending)
            throw Object.assign(
              new Error("Pending release recovery must finish before update"),
              { statusCode: 409 },
            );
        },
      );
    }
    // Source origin is administrator configuration, never a URL supplied through the public API.
    const config = await json<{ baseUrl: string }>(
      "/etc/hotspark/releases.json",
    );
    if (!config?.baseUrl || !config.baseUrl.startsWith("https://"))
      throw new Error("Release origin is not configured");
    const image = (
      await this.docker([
        "inspect",
        "--format",
        "{{.Image}}",
        "hotspark-agent-1",
      ])
    ).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Installed agent image unavailable");
    await atomicWrite(
      this.journal(op.taskId),
      JSON.stringify({ status: "running", hash: stableHash(op) }),
    );
    await this.docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${labelPrefix}.update_task=${op.taskId}`,
      "--restart=no",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--pids-limit",
      "256",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--log-driver",
      "local",
      "--log-opt",
      "max-size=10m",
      "--log-opt",
      "max-file=2",
      "--mount",
      "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock",
      "--mount",
      "type=bind,src=/etc/hotspark,dst=/etc/hotspark",
      "--mount",
      "type=bind,src=/opt/hotspark,dst=/opt/hotspark",
      "--mount",
      "type=bind,src=/var/lib/hotspark,dst=/var/lib/hotspark",
      image,
      "bash",
      "/app/installer/update.sh",
      op.version,
      op.sha256,
      op.taskId,
    ]);
    return { status: "running" };
  }
}
