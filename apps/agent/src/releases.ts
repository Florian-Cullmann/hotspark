import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  applicationSpecSchema,
  projectIdSchema,
  type AgentOperation,
  type ApplicationSpec,
} from "../../../packages/application-spec/src/index.js";
import {
  catalog,
  labelPrefix,
  planDeployment,
  stableHash,
  type DeploymentPlan,
} from "../../../packages/providers/src/index.js";
import { seal, unseal, redact } from "../../../packages/shared/src/secrets.js";
import {
  Runtime,
  atomicWrite,
  renderCompose,
  renderRoutes,
  type Vault,
} from "./runtime.js";
import {
  command,
  exists,
  withProjectLock,
  type CommandRunner,
} from "./process.js";
import { gitFetcher, type SourceFetcher } from "./git.js";
export interface ActiveRelease {
  id: string;
  plan: DeploymentPlan;
  compose: string;
  legacy?: boolean;
}
interface ProjectState {
  version: 3;
  active: ActiveRelease | null;
  previous: ActiveRelease | null;
  manualMaintenance: boolean;
  maintenance: boolean;
  fallbackPlan?: DeploymentPlan;
  pending?: { operationId: string; deploymentId: string };
}
export interface ReleaseRecord {
  version: 1;
  id: string;
  projectId: string;
  status: string;
  previousReleaseId: string | null;
  rollbackOfId?: string;
  sources: {
    service: string;
    repository: string;
    branch?: string;
    tag?: string;
    commit: string;
  }[];
  images: { service: string; reference: string; digest: string }[];
  events: { phase: string; time: string; message: string }[];
  health: { service: string; healthy: boolean; checkedAt: string }[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
  hooks: string[];
  plan?: DeploymentPlan;
  compose?: string;
}
interface Journal {
  id: string;
  hash: string;
  status: "running" | "succeeded" | "failed";
  phase: string;
  progress: number;
  projectId: string;
  deploymentId?: string;
  result?: Record<string, unknown>;
  error?: string;
}
interface Compose {
  name: string;
  services: Record<string, Record<string, unknown>>;
  volumes: Record<string, unknown>;
  secrets: Record<string, unknown>;
  networks: Record<string, unknown>;
}
const now = () => new Date().toISOString();
async function read<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export class ReleaseRuntime {
  private readonly fetchSource: SourceFetcher;
  constructor(
    private readonly legacy: Runtime,
    private readonly root: string,
    private readonly routes: string,
    private readonly secretRoot: string,
    private readonly key: string,
    private readonly tls = false,
    private readonly run: CommandRunner = command,
    fetchSource?: SourceFetcher,
  ) {
    this.fetchSource = fetchSource ?? gitFetcher(run);
  }
  private dir(id: string) {
    projectIdSchema.parse(id);
    return join(this.root, id);
  }
  private releaseDir(project: string, id: string) {
    projectIdSchema.parse(id);
    return join(this.dir(project), "releases", id);
  }
  private statePath(id: string) {
    return join(this.dir(id), "release-state.json");
  }
  private journalPath(id: string) {
    projectIdSchema.parse(id);
    return join(this.root, ".operations", `${id}.json`);
  }
  private secretBase(release: string) {
    return join(this.secretRoot, "releases", release);
  }
  private compose(project: string, path: string) {
    return ["compose", "--project-name", `hs-${project}`, "--file", path];
  }
  private async state(id: string): Promise<ProjectState> {
    const state = await read<ProjectState>(this.statePath(id));
    if (state) return state;
    const pointer = await read<{ deploymentId: string }>(
      join(this.dir(id), "current.json"),
    );
    const plan = await read<DeploymentPlan>(join(this.dir(id), "plan.json"));
    return {
      version: 3,
      active:
        pointer && plan
          ? {
              id: pointer.deploymentId,
              plan,
              compose: join(this.dir(id), "compose.json"),
              legacy: true,
            }
          : null,
      previous: null,
      manualMaintenance: false,
      maintenance: false,
    };
  }
  private async save(id: string, state: ProjectState) {
    await atomicWrite(this.statePath(id), JSON.stringify(state));
  }
  private async record(project: string, id: string) {
    return read<ReleaseRecord>(
      join(this.releaseDir(project, id), "release.json"),
    );
  }
  private async writeRecord(record: ReleaseRecord) {
    await atomicWrite(
      join(this.releaseDir(record.projectId, record.id), "release.json"),
      JSON.stringify(record),
    );
  }
  private async publish(
    project: string,
    state: ProjectState,
    fallback?: DeploymentPlan,
  ) {
    const plan = state.active?.plan ?? fallback ?? state.fallbackPlan;
    if (!plan) {
      await rm(join(this.routes, `${project}.yaml`), { force: true });
      return;
    }
    const config = renderRoutes(plan, this.tls);
    if (!Object.keys(config.http.routers).length) {
      await rm(join(this.routes, `${project}.yaml`), { force: true });
      return;
    }
    if (state.maintenance)
      for (const key of Object.keys(config.http.services))
        config.http.services[key] = {
          loadBalancer: {
            servers: [{ url: "http://hotspark-maintenance:8080" }],
            healthCheck: { path: "/health", interval: "5s", timeout: "3s" },
          },
        };
    await mkdir(this.routes, { recursive: true, mode: 0o755 });
    await atomicWrite(
      join(this.routes, `${project}.yaml`),
      JSON.stringify(config),
      0o644,
    );
  }
  private async logs(record: ReleaseRecord, text: string, vault: Vault) {
    const file = join(this.releaseDir(record.projectId, record.id), "logs.txt");
    const previous = await readFile(file, "utf8").catch(() => "");
    const safe = redact(text, [
      ...vault.redactions,
      ...Object.values(vault.user).flatMap(Object.values),
      ...Object.values(vault.databases).map((d) => d.password),
    ]);
    await atomicWrite(
      file,
      Buffer.from(previous + `\n[${now()} ${record.status}]\n` + safe)
        .subarray(-1024 * 1024)
        .toString("utf8"),
    );
  }
  private async prepareVault(
    project: string,
    plan: DeploymentPlan,
    cipher?: string,
  ) {
    const vault = await this.legacy.vault(project);
    if (cipher) {
      vault.redactions = [
        ...new Set([
          ...vault.redactions,
          ...Object.values(vault.user).flatMap(Object.values),
        ]),
      ].slice(-500);
      vault.user = unseal(cipher, this.key, `project:${project}`);
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
        for (const name of s.spec.secrets)
          if (!vault.user[s.name]?.[name])
            throw new Error("Missing declared secret");
    await atomicWrite(
      join(this.dir(project), "vault.enc"),
      seal(vault, this.key, `vault:${project}`),
    );
    return vault;
  }
  private async infra(
    project: string,
    plan: DeploymentPlan,
    vault: Vault,
    run: (args: string[]) => Promise<string>,
  ) {
    const infrastructurePlan = {
      ...plan,
      services: plan.services.filter((s) => s.type === "postgres"),
      builds: [],
    };
    await this.legacy.materialize(infrastructurePlan, vault);
    const full = renderCompose(infrastructurePlan, this.secretRoot) as Compose;
    const dbs = plan.services
      .filter((s) => s.type === "postgres")
      .map((s) => s.id);
    full.services = Object.fromEntries(
      Object.entries(full.services).filter(([name]) => dbs.includes(name)),
    );
    delete full.networks.proxy;
    const file = join(this.dir(project), "infrastructure.json");
    await atomicWrite(file, JSON.stringify(full));
    const network = `hs-${project}_private`;
    try {
      await run(["network", "inspect", network]);
    } catch {
      await run([
        "network",
        "create",
        "--driver",
        "bridge",
        "--label",
        `com.docker.compose.project=hs-${project}`,
        "--label",
        "com.docker.compose.network=private",
        network,
      ]);
    }
    if (dbs.length)
      await run([
        ...this.compose(project, file),
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "180",
        ...dbs,
      ]);
  }
  private candidatePlan(plan: DeploymentPlan, id: string) {
    const candidate = structuredClone(plan);
    for (const s of candidate.services)
      if (s.type !== "postgres") {
        s.id = `r-${createHash("sha256").update(`${plan.projectId}:${id}:${s.name}`).digest("hex").slice(0, 32)}`;
        s.alias = s.id;
      }
    return candidate;
  }
  private async candidate(
    project: string,
    id: string,
    plan: DeploymentPlan,
    vault: Vault,
  ) {
    await this.legacy.materialize(plan, vault, this.secretBase(id));
    const config = renderCompose(plan, this.secretBase(id)) as Compose;
    config.services = Object.fromEntries(
      Object.entries(config.services).filter(([name]) =>
        plan.services.some((s) => s.id === name && s.type !== "postgres"),
      ),
    );
    config.volumes = {};
    config.networks.private = { external: true, name: `hs-${project}_private` };
    for (const s of plan.services)
      if (s.spec.type !== "postgres") {
        const service = config.services[s.id]!;
        delete service.depends_on;
        service.labels = {
          ...(service.labels as object),
          [`${labelPrefix}.project_id`]: project,
          [`${labelPrefix}.deployment_id`]: id,
          [`${labelPrefix}.service`]: s.name,
        };
        if (service.healthcheck) {
          const hc = s.spec.runtime.healthcheck;
          const check = service.healthcheck as Record<string, unknown>;
          check.interval = `${hc?.intervalSeconds ?? 5}s`;
          check.timeout = `${hc?.timeoutSeconds ?? 3}s`;
          check.retries = hc?.retries ?? 12;
          check.start_period = "0s";
          if (s.type !== "react")
            check.test = [
              "CMD",
              "node",
              "-e",
              `fetch('http://127.0.0.1:${s.port}${hc?.path ?? s.spec.runtime.healthPath}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
            ];
        }
      }
    const file = join(this.releaseDir(project, id), "compose.json");
    await atomicWrite(file, JSON.stringify(config));
    return file;
  }
  private async check(
    active: ActiveRelease,
    run: (args: string[]) => Promise<string>,
    once = false,
    signal?: AbortSignal,
  ) {
    const health: ReleaseRecord["health"] = [];
    for (const s of active.plan.services) {
      const policy =
        s.spec.type !== "postgres" ? s.spec.runtime.healthcheck : undefined;
      const retries = once ? 1 : (policy?.retries ?? 12);
      let healthy = false;
      for (let attempt = 0; attempt < retries; attempt++) {
        if (signal?.aborted) throw new Error("Operation cancelled");
        try {
          const file =
            s.type === "postgres"
              ? join(this.dir(active.plan.projectId), "infrastructure.json")
              : active.compose;
          const actualFile = (await exists(file)) ? file : active.compose;
          const ids = (
            await run([
              ...this.compose(active.plan.projectId, actualFile),
              "ps",
              "--all",
              "--quiet",
              s.id,
            ])
          ).trim();
          if (!/^[a-f0-9]{12,64}$/.test(ids))
            throw new Error("Missing container");
          const info = JSON.parse(await run(["inspect", ids])) as {
            State: { Running: boolean; Health?: { Status: string } };
          }[];
          if (
            !info[0]?.State.Running ||
            (info[0].State.Health && info[0].State.Health.Status !== "healthy")
          )
            throw new Error("Container is not healthy");
          if (s.spec.type !== "postgres") {
            const probe = `hs-probe-${active.id}-${s.id}`;
            const url = `http://${s.id}:${s.port}${policy?.path ?? s.spec.runtime.healthPath}`;
            try {
              await run([
                "run",
                "--rm",
                "--name",
                probe,
                "--network",
                `hs-${active.plan.projectId}_private`,
                "--user",
                "10001:10001",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--memory",
                "128m",
                "--pids-limit",
                "32",
                catalog.node["24"],
                "node",
                "-e",
                `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(${(policy?.timeoutSeconds ?? 3) * 1000})}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
              ]);
            } finally {
              await run(["rm", "--force", probe]).catch(() => {});
            }
          }
          healthy = true;
          break;
        } catch {
          if (attempt + 1 < retries)
            await new Promise((r) =>
              setTimeout(r, (policy?.intervalSeconds ?? 5) * 1000),
            );
        }
      }
      health.push({ service: s.name, healthy, checkedAt: now() });
      if (!healthy)
        throw Object.assign(
          new Error(`Health verification failed for ${s.name}`),
          { health },
        );
    }
    return health;
  }
  private async cleanup(active: ActiveRelease) {
    const ids = active.plan.services
      .filter((s) => s.type !== "postgres")
      .map((s) => s.id);
    for (const id of ids)
      await this.run(
        "/usr/bin/docker",
        ["rm", "--force", `hs-hook-${active.id}-${id}`],
        { timeout: 30000 },
      ).catch(() => {});
    if (ids.length)
      await this.run(
        "/usr/bin/docker",
        [
          ...this.compose(active.plan.projectId, active.compose),
          "rm",
          "--force",
          "--stop",
          ...ids,
        ],
        { timeout: 60000 },
      );
  }
  private outcome(state: ProjectState, record?: ReleaseRecord) {
    return {
      activeDeploymentId: state.active?.id ?? null,
      maintenance: state.maintenance,
      state: state.active ? "running" : "failed",
      ...(record
        ? {
            release: { ...record, plan: undefined, compose: undefined },
            sources: record.sources,
            images: record.images,
            health: record.health,
            resolvedSpec: record.plan?.spec,
          }
        : {}),
    };
  }
  async execute(op: AgentOperation): Promise<unknown> {
    if (op.operation === "operation-status")
      return read<Journal>(this.journalPath(op.operationId));
    if (op.operation === "host-info") return this.legacy.execute(op);
    if (op.operation === "deployment-details") {
      const record = await this.record(op.projectId, op.deploymentId);
      if (!record)
        throw Object.assign(new Error("Release not found"), {
          statusCode: 404,
        });
      const { plan, compose, ...safe } = record;
      void plan;
      void compose;
      return {
        ...safe,
        logs: await readFile(
          join(this.releaseDir(op.projectId, op.deploymentId), "logs.txt"),
          "utf8",
        )
          .catch(() => "")
          .then((text) =>
            Buffer.from(text)
              .subarray(-256 * 1024)
              .toString("utf8"),
          ),
      };
    }
    if (op.operation === "cancel-deployment") {
      const record = await this.record(op.projectId, op.deploymentId);
      if (
        !record ||
        !["queued", "cloning", "building", "built"].includes(record.status)
      )
        throw Object.assign(
          new Error("Only pre-migration builds can be cancelled"),
          { statusCode: 409 },
        );
      await writeFile(
        join(this.releaseDir(op.projectId, op.deploymentId), "cancel"),
        "cancel",
        { mode: 0o600 },
      );
      return { requested: true };
    }
    if (op.operation === "inspect") return this.inspect(op.projectId);
    if (op.operation === "logs") {
      const state = await this.state(op.projectId);
      if (!state.active || state.active.legacy) return this.legacy.execute(op);
      const service = state.active.plan.services.find(
        (s) => s.name === op.service,
      );
      if (!service) throw new Error("Unknown service");
      const file =
        service.type === "postgres"
          ? join(this.dir(op.projectId), "infrastructure.json")
          : state.active.compose;
      const ids = (
        await this.run("/usr/bin/docker", [
          ...this.compose(op.projectId, file),
          "ps",
          "--all",
          "--quiet",
          service.id,
        ])
      ).trim();
      if (!/^[a-f0-9]{12,64}$/.test(ids))
        return { text: "", stream: op.stream };
      // Docker CLI multiplexes stderr; a fixed Node collector in legacy runtime handles selected streams.
      const output = await this.run(
        "/usr/bin/docker",
        ["logs", "--tail", String(op.lines), "--timestamps", ids],
        { timeout: 10000, stream: op.stream },
      );
      const vault = await this.releaseVault(op.projectId, state.active.id);
      return {
        text: Buffer.from(
          redact(output, [
            ...Object.values(vault.user).flatMap(Object.values),
            ...Object.values(vault.databases).map((d) => d.password),
          ]),
        )
          .subarray(-256 * 1024)
          .toString("utf8"),
        stream: op.stream,
        maxBytes: 256 * 1024,
      };
    }
    return withProjectLock(
      join(this.root, ".locks", op.projectId),
      async () => {
        await mkdir(join(this.root, ".operations"), {
          recursive: true,
          mode: 0o700,
        });
        const old = await read<Journal>(this.journalPath(op.operationId));
        if (old && old.hash !== stableHash(op))
          throw new Error("Operation ID reused");
        if (old?.status === "succeeded") return old.result;
        if (old?.status === "failed")
          throw new Error(old.error ?? "Previous operation failed");
        if (old?.status === "running" && old.deploymentId) {
          await this.recoverProject(op.projectId, old);
          throw new Error(
            "Interrupted release recovered; submit a new deployment",
          );
        }
        if (op.operation === "deploy") return this.deploy(op);
        const state = await this.state(op.projectId);
        if (
          op.operation !== "maintenance" &&
          !(await exists(this.statePath(op.projectId)))
        )
          return this.legacy.execute(op);
        const journal: Journal = {
          id: op.operationId,
          hash: stableHash(op),
          status: "running",
          phase: op.operation,
          progress: 10,
          projectId: op.projectId,
        };
        await atomicWrite(
          this.journalPath(op.operationId),
          JSON.stringify(journal),
        );
        try {
          if (op.operation === "maintenance") {
            if (
              !state.active &&
              (await exists(join(this.dir(op.projectId), "compose.json")))
            )
              throw new Error(
                "Legacy project requires explicit migration before maintenance",
              );
            state.manualMaintenance = op.enabled;
            state.maintenance = op.enabled;
            await this.save(op.projectId, state);
            await this.publish(op.projectId, state);
          } else if (op.operation === "remove") {
            await rm(join(this.routes, `${op.projectId}.yaml`), {
              force: true,
            });
            const ids = (
              await this.run("/usr/bin/docker", [
                "ps",
                "--all",
                "--quiet",
                "--filter",
                `label=com.docker.compose.project=hs-${op.projectId}`,
              ])
            )
              .trim()
              .split(/\s+/)
              .filter(Boolean);
            if (ids.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
              throw new Error("Invalid container identity");
            if (ids.length)
              await this.run("/usr/bin/docker", ["rm", "--force", ...ids], {
                timeout: 60000,
              });
            await this.run("/usr/bin/docker", [
              "network",
              "rm",
              `hs-${op.projectId}_private`,
            ]).catch(() => {});
            for (const id of await readdir(
              join(this.dir(op.projectId), "releases"),
            ).catch(() => [])) {
              if (projectIdSchema.safeParse(id).success)
                await rm(join(this.secretBase(id), op.projectId), {
                  recursive: true,
                  force: true,
                });
            }
            await atomicWrite(
              join(this.dir(op.projectId), "removed.json"),
              JSON.stringify({ operationId: op.operationId }),
            );
            state.active = null;
            state.previous = null;
            state.maintenance = false;
            await this.save(op.projectId, state);
          } else {
            if (!state.active) throw new Error("Project has no active release");
            const run = (args: string[]) =>
              this.run("/usr/bin/docker", args, { timeout: 180000 });
            if (op.operation === "stop" || op.operation === "restart") {
              for (const release of [state.previous, state.active]) {
                if (!release) continue;
                const ids = release.plan.services
                  .filter((s) => s.type !== "postgres")
                  .map((s) => s.id);
                if (ids.length)
                  await run([
                    ...this.compose(op.projectId, release.compose),
                    "stop",
                    ...ids,
                  ]);
              }
              const infra = join(this.dir(op.projectId), "infrastructure.json");
              if (await exists(infra)) {
                const c = await read<Compose>(infra);
                if (Object.keys(c!.services).length)
                  await run([...this.compose(op.projectId, infra), "stop"]);
              }
            }
            if (op.operation !== "stop") {
              const vault = await this.releaseVault(
                op.projectId,
                state.active.id,
              );
              await this.infra(op.projectId, state.active.plan, vault, run);
              await this.startCandidate(state.active, run);
              await this.check(state.active, run);
              await this.publish(op.projectId, state);
            }
          }
          journal.status = "succeeded";
          journal.progress = 100;
          const inspected =
            op.operation === "maintenance"
              ? ((await this.inspect(op.projectId)) as { state: string })
              : null;
          journal.result = {
            ...this.outcome(state),
            state:
              inspected?.state ??
              (op.operation === "stop"
                ? "stopped"
                : op.operation === "remove"
                  ? "deleted"
                  : state.active
                    ? "running"
                    : "created"),
          };
        } catch {
          journal.status = "failed";
          journal.error = "Lifecycle operation failed";
          throw new Error(journal.error);
        } finally {
          await atomicWrite(
            this.journalPath(op.operationId),
            JSON.stringify(journal),
          );
        }
        return journal.result;
      },
    );
  }
  private async releaseVault(project: string, id: string) {
    const encrypted = await readFile(
      join(this.releaseDir(project, id), "vault.enc"),
      "utf8",
    ).catch(() => null);
    return encrypted
      ? unseal<Vault>(encrypted, this.key, `release:${project}:${id}`)
      : this.legacy.vault(project);
  }
  private async startCandidate(
    active: ActiveRelease,
    run: (args: string[]) => Promise<string>,
  ) {
    const ids = active.plan.services
      .filter((s) => s.type !== "postgres")
      .map((s) => s.id);
    if (ids.length)
      await run([
        ...this.compose(active.plan.projectId, active.compose),
        "up",
        "--detach",
        "--no-deps",
        ...ids,
      ]);
  }
  private async deploy(op: Extract<AgentOperation, { operation: "deploy" }>) {
    const state = await this.state(op.projectId),
      dir = this.releaseDir(op.projectId, op.deploymentId);
    if (
      !state.active &&
      (await exists(join(this.dir(op.projectId), "compose.json"))) &&
      !(await exists(join(this.dir(op.projectId), "plan.json")))
    )
      throw new Error("Legacy project requires explicit migration");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const record: ReleaseRecord = {
      version: 1,
      id: op.deploymentId,
      projectId: op.projectId,
      status: "queued",
      previousReleaseId: state.active?.id ?? null,
      ...(op.rollbackOf ? { rollbackOfId: op.rollbackOf } : {}),
      sources: [],
      images: [],
      events: [],
      health: [],
      createdAt: now(),
      hooks: [],
    };
    const journal: Journal = {
      id: op.operationId,
      hash: stableHash(op),
      status: "running",
      phase: "queued",
      progress: 0,
      projectId: op.projectId,
      deploymentId: op.deploymentId,
    };
    state.pending = {
      operationId: op.operationId,
      deploymentId: op.deploymentId,
    };
    await this.save(op.projectId, state);
    let vault = await this.legacy.vault(op.projectId),
      candidate: ActiveRelease | undefined;
    const controller = new AbortController();
    let checkingCancel = false;
    const cancellation = setInterval(() => {
      if (checkingCancel) return;
      checkingCancel = true;
      void exists(join(dir, "cancel"))
        .then((cancel) => {
          if (
            cancel &&
            ["queued", "cloning", "building", "built"].includes(record.status)
          )
            controller.abort();
        })
        .finally(() => {
          checkingCancel = false;
        });
    }, 500);
    const run = (args: string[]) =>
      this.run("/usr/bin/docker", args, {
        timeout: 840000,
        signal: controller.signal,
        onLog: (text) => this.logs(record, text, vault),
      });
    const checkpoint = async (
      phase: string,
      progress: number,
      message = phase,
    ) => {
      record.status = phase;
      journal.phase = phase;
      journal.progress = progress;
      record.events.push({ phase, time: now(), message });
      record.events = record.events.slice(-200);
      await this.writeRecord(record);
      await atomicWrite(
        this.journalPath(op.operationId),
        JSON.stringify(journal),
      );
    };
    try {
      await checkpoint("queued", 1, "deployment queued");
      const spec = applicationSpecSchema.parse(structuredClone(op.spec));
      state.fallbackPlan = planDeployment(
        op.projectId,
        this.placeholderSpec(spec),
      );
      await this.save(op.projectId, state);
      if (spec.deployment.maintenance === "entire-deployment") {
        state.maintenance = true;
        await this.save(op.projectId, state);
        await this.publish(
          op.projectId,
          state,
          planDeployment(op.projectId, this.placeholderSpec(spec)),
        );
      }
      let plan: DeploymentPlan;
      if (op.rollbackOf) {
        const target = await this.record(op.projectId, op.rollbackOf);
        if (
          target?.plan &&
          ["active", "superseded", "rolled_back"].includes(target.status)
        ) {
          plan = structuredClone(target.plan);
          record.sources = target.sources;
        } else if (state.active?.id === op.rollbackOf && state.active.legacy)
          plan = structuredClone(state.active.plan);
        else
          throw new Error(
            "Rollback target is not an available successful release",
          );
        vault = await this.releaseVault(op.projectId, op.rollbackOf);
        record.images = plan.services
          .filter((s) => s.type !== "postgres")
          .map((s) => ({
            service: s.name,
            reference: s.image,
            digest: s.image,
          }));
        for (const image of record.images)
          await run(["image", "inspect", image.digest]);
        await checkpoint(
          "built",
          45,
          "rollback images verified; source build skipped",
        );
      } else {
        await checkpoint("cloning", 5, "source fetch started");
        const work = join(this.dir(op.projectId), "workspaces", op.operationId);
        for (const [name, s] of Object.entries(spec.services))
          if (s.type !== "postgres" && s.source.type === "git") {
            const commit = await this.fetchSource(s.source, join(work, name), {
              signal: controller.signal,
              onLog: (text) => this.logs(record, text, vault),
            });
            s.source.commit = commit;
            record.sources.push({
              service: name,
              repository: s.source.repository,
              ...(s.source.branch ? { branch: s.source.branch } : {}),
              ...(s.source.tag ? { tag: s.source.tag } : {}),
              commit,
            });
            await checkpoint(
              "cloning",
              10,
              `source resolved: ${name} ${commit}`,
            );
          }
        plan = planDeployment(op.projectId, spec);
        vault = await this.prepareVault(
          op.projectId,
          plan,
          op.encryptedSecrets,
        );
        await checkpoint("building", 20, "build started");
        for (const build of plan.builds) {
          const image = `hotspark/${op.projectId}/${build.id}:${op.deploymentId}`;
          const context = join(work, `${build.id}-template`);
          await mkdir(context, { recursive: true, mode: 0o700 });
          const args = [
            "buildx",
            "build",
            "--load",
            "--provenance=false",
            "--progress",
            "plain",
            "--tag",
            image,
            "--label",
            `${labelPrefix}.project_id=${op.projectId}`,
            "--label",
            `${labelPrefix}.deployment_id=${op.deploymentId}`,
            "--label",
            `${labelPrefix}.commit_sha=${build.commit}`,
            "--label",
            `${labelPrefix}.service=${build.service}`,
          ];
          if (build.dockerfile) {
            await atomicWrite(join(context, "Dockerfile"), build.dockerfile);
            for (const [file, value] of Object.entries(build.files))
              await atomicWrite(join(context, file), value, 0o644);
            args.push(
              "--build-context",
              `source=${join(work, build.service)}`,
              "--file",
              join(context, "Dockerfile"),
              context,
            );
          } else args.push(join(work, build.service));
          await run(args);
          const digest = (
            await run(["image", "inspect", "--format", "{{.Id}}", image])
          ).trim();
          if (!/^sha256:[a-f0-9]{64}$/.test(digest))
            throw new Error("Build did not produce an immutable image ID");
          const plannedService = plan.services.find(
            (s) => s.name === build.service,
          )!;
          plannedService.image = digest;
          if (
            build.dockerfile &&
            plannedService.spec.type !== "postgres" &&
            plannedService.spec.hooks.some(
              (h) => h.type === "prisma-migrate-deploy",
            )
          ) {
            const migrationTag = `${image}-migration`;
            const migrationArgs = [...args];
            migrationArgs[migrationArgs.indexOf("--tag") + 1] = migrationTag;
            migrationArgs.splice(
              migrationArgs.length - 1,
              0,
              "--target",
              "migration",
            );
            await run(migrationArgs);
            const migrationDigest = (
              await run([
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                migrationTag,
              ])
            ).trim();
            if (!/^sha256:[a-f0-9]{64}$/.test(migrationDigest))
              throw new Error("Invalid migration image");
            plannedService.migrationImage = migrationDigest;
          }
          record.images.push({
            service: build.service,
            reference: image,
            digest,
          });
          await checkpoint(
            "building",
            40,
            `image built: ${build.service} ${digest}`,
          );
        }
        for (const s of plan.services)
          if (
            s.type !== "postgres" &&
            s.spec.type !== "postgres" &&
            s.spec.source.type === "image"
          ) {
            await run(["pull", s.image]);
            const digest = (
              await run(["image", "inspect", "--format", "{{.Id}}", s.image])
            ).trim();
            if (!/^sha256:[a-f0-9]{64}$/.test(digest))
              throw new Error("Invalid immutable image");
            record.images.push({ service: s.name, reference: s.image, digest });
            s.image = digest;
          }
        await checkpoint("built", 45, "images built");
        if (await exists(join(dir, "cancel"))) {
          controller.abort();
          throw new Error("Deployment cancelled");
        }
      }
      if (controller.signal.aborted) throw new Error("Operation cancelled");
      plan = this.candidatePlan(plan, op.deploymentId);
      record.plan = plan;
      await atomicWrite(
        join(dir, "vault.enc"),
        seal(vault, this.key, `release:${op.projectId}:${op.deploymentId}`),
      );
      await this.infra(op.projectId, plan, vault, run);
      record.compose = await this.candidate(
        op.projectId,
        op.deploymentId,
        plan,
        vault,
      );
      candidate = { id: op.deploymentId, plan, compose: record.compose };
      await this.writeRecord(record);
      for (const s of plan.services)
        if (s.spec.type !== "postgres")
          for (const hook of s.spec.hooks)
            if (hook.type === "image-check")
              await run(["image", "inspect", s.image]);
      if (await exists(join(dir, "cancel"))) {
        controller.abort();
        throw new Error("Deployment cancelled");
      }
      const migrations =
        !op.rollbackOf &&
        plan.services.some(
          (s) =>
            s.spec.type !== "postgres" &&
            s.spec.hooks.some((h) => h.type === "prisma-migrate-deploy"),
        );
      if (migrations && spec.deployment.maintenance !== "never") {
        state.maintenance = true;
        await this.save(op.projectId, state);
        await this.publish(op.projectId, state, plan);
      }
      if (!op.rollbackOf)
        for (const s of plan.services)
          if (s.spec.type !== "postgres")
            for (const hook of s.spec.hooks)
              if (hook.type === "prisma-migrate-deploy") {
                record.hooks.push(`started:${s.name}`);
                await checkpoint(
                  "migrating",
                  55,
                  `migration started: ${s.name}`,
                );
                if (!s.migrationImage)
                  throw new Error("Missing migration image");
                const hookConfig = await read<Compose>(record.compose);
                hookConfig!.services[s.id]!.image = s.migrationImage;
                const hookFile = join(dir, `${s.id}-hook.json`);
                await atomicWrite(hookFile, JSON.stringify(hookConfig));
                await run([
                  ...this.compose(op.projectId, hookFile),
                  "run",
                  "--rm",
                  "--no-deps",
                  "--name",
                  `hs-hook-${op.deploymentId}-${s.id}`,
                  "--entrypoint",
                  "node",
                  s.id,
                  "/opt/hotspark/loader.mjs",
                  "--migrate",
                ]);
                record.hooks.push(`completed:${s.name}`);
                await checkpoint(
                  "migrating",
                  60,
                  `migration completed: ${s.name}`,
                );
              }
      await checkpoint("starting", 65, "candidate starting");
      await this.startCandidate(candidate, run);
      await checkpoint(
        "healthchecking",
        75,
        "candidate started; health verification",
      );
      record.health = await this.check(
        candidate,
        run,
        false,
        controller.signal,
      );
      await checkpoint("healthchecking", 85, "health check passed");
      await checkpoint("activating", 90, "traffic switch prepared");
      const previous = state.active;
      const next: ProjectState = {
        version: 3,
        active: candidate,
        previous,
        manualMaintenance: state.manualMaintenance,
        maintenance: state.manualMaintenance,
        pending: state.pending,
      };
      // Route replacement first; durable active pointer is the commit point. Recovery restores previous if uncommitted.
      await this.publish(op.projectId, next);
      await this.save(op.projectId, next);
      Object.assign(state, next);
      await checkpoint("activating", 95, "traffic switched");
      if (
        !op.rollbackOf &&
        plan.services.some(
          (s) =>
            s.spec.type !== "postgres" &&
            s.spec.hooks.some((h) => h.type === "http-health"),
        )
      )
        await this.check(candidate, run, true);
      delete state.pending;
      await this.save(op.projectId, state);
      record.finishedAt = now();
      await checkpoint("active", 100, "deployment active");
      if (previous) {
        const old = await this.record(op.projectId, previous.id);
        if (old) {
          old.status = op.rollbackOf ? "rolled_back" : "superseded";
          await this.writeRecord(old);
        }
      }
      journal.status = "succeeded";
      journal.result = this.outcome(state, record);
      await atomicWrite(
        this.journalPath(op.operationId),
        JSON.stringify(journal),
      );
      await this.retention(op.projectId, state).catch(() => {});
      return journal.result;
    } catch (e) {
      const error = e instanceof Error ? e.message : "Deployment failed";
      if ("health" in (e as object))
        record.health = (e as { health: ReleaseRecord["health"] }).health;
      // A post-deploy check can fail after the pointer commit; restore its recorded predecessor explicitly.
      if (state.active?.id === op.deploymentId) {
        state.active = state.previous;
        state.previous = null;
      }
      let previousHealthy = false;
      if (state.active)
        try {
          await this.check(
            state.active,
            (args) => this.run("/usr/bin/docker", args, { timeout: 30000 }),
            true,
          );
          previousHealthy = true;
        } catch {
          /* maintenance remains when the prior app cannot serve */
        }
      state.maintenance = previousHealthy ? state.manualMaintenance : true;
      delete state.pending;
      await this.save(op.projectId, state);
      await this.publish(op.projectId, state, record.plan).catch(() => {});
      if (candidate) await this.cleanup(candidate).catch(() => {});
      record.error = redact(error, [
        ...Object.values(vault.user).flatMap(Object.values),
        ...Object.values(vault.databases).map((d) => d.password),
      ]);
      record.finishedAt = now();
      await checkpoint(
        controller.signal.aborted ? "cancelled" : "failed",
        100,
        record.error,
      );
      journal.status = "failed";
      journal.error = record.error;
      journal.result = {
        ...this.outcome(state, record),
        state: previousHealthy
          ? "running"
          : state.active
            ? "degraded"
            : "failed",
      };
      await atomicWrite(
        this.journalPath(op.operationId),
        JSON.stringify(journal),
      );
      throw Object.assign(new Error(record.error), { statusCode: 500 });
    } finally {
      clearInterval(cancellation);
      await this.retention(op.projectId, state).catch(() => {});
      await rm(join(this.dir(op.projectId), "workspaces", op.operationId), {
        recursive: true,
        force: true,
      });
    }
  }
  private placeholderSpec(spec: ApplicationSpec) {
    const copy = structuredClone(spec);
    for (const s of Object.values(copy.services))
      if (s.type !== "postgres" && s.source.type === "git")
        s.source.commit ??= "0".repeat(40);
    return copy;
  }
  private async retention(project: string, state: ProjectState) {
    const directory = join(this.dir(project), "releases");
    const entries = await readdir(directory).catch(() => []);
    const records = (
      await Promise.all(
        entries
          .filter((id) => projectIdSchema.safeParse(id).success)
          .map((id) => this.record(project, id)),
      )
    )
      .filter((r): r is ReleaseRecord => !!r)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      if (
        record.id !== state.active?.id &&
        record.id !== state.previous?.id &&
        record.plan &&
        record.compose
      )
        await this.cleanup({
          id: record.id,
          plan: record.plan,
          compose: record.compose,
        }).catch(() => {});
      if (i >= 20 || Date.now() - Date.parse(record.createdAt) > 14 * 86400000)
        await rm(join(this.releaseDir(project, record.id), "logs.txt"), {
          force: true,
        });
    }
  }
  async inspect(project: string) {
    if (!(await exists(this.statePath(project))))
      return this.legacy.execute({ operation: "inspect", projectId: project });
    const state = await this.state(project);
    if (!state.active)
      return {
        state: "created",
        services: [],
        activeDeploymentId: null,
        maintenance: state.maintenance,
      };
    const services = [];
    for (const s of state.active.plan.services) {
      try {
        const file =
          s.type === "postgres" &&
          (await exists(join(this.dir(project), "infrastructure.json")))
            ? join(this.dir(project), "infrastructure.json")
            : state.active.compose;
        const id = (
          await this.run(
            "/usr/bin/docker",
            [...this.compose(project, file), "ps", "--all", "--quiet", s.id],
            { timeout: 10000 },
          )
        ).trim();
        const info = JSON.parse(
          await this.run("/usr/bin/docker", ["inspect", id], {
            timeout: 10000,
          }),
        ) as { State: { Status: string; Health?: { Status: string } } }[];
        services.push({
          name: s.name,
          state: info[0]!.State.Status,
          health: info[0]!.State.Health?.Status ?? "",
        });
      } catch {
        services.push({ name: s.name, state: "missing", health: "" });
      }
    }
    const observed = services.every((s) =>
      ["exited", "created", "missing"].includes(s.state),
    )
      ? "stopped"
      : services.every(
            (s) =>
              s.state === "running" &&
              !["unhealthy", "starting"].includes(s.health),
          )
        ? "running"
        : "degraded";
    return {
      state: observed,
      services,
      activeDeploymentId: state.active.id,
      maintenance: state.maintenance,
    };
  }
  private async recoverProject(project: string, journal: Journal) {
    const state = await this.state(project),
      record = journal.deploymentId
        ? await this.record(project, journal.deploymentId)
        : null;
    if (!record) {
      journal.status = "failed";
      journal.error = "Interrupted operation requires a new request";
      await atomicWrite(this.journalPath(journal.id), JSON.stringify(journal));
      return;
    }
    if (state.active?.id === record.id) {
      try {
        record.health = await this.check(
          state.active,
          (args) => this.run("/usr/bin/docker", args, { timeout: 30000 }),
          true,
        );
        await this.publish(project, state);
        record.status = "active";
        record.finishedAt = now();
        journal.status = "succeeded";
        journal.phase = "active";
        journal.progress = 100;
      } catch {
        state.active = state.previous;
        state.previous = null;
        journal.status = "failed";
        record.status = "failed";
        record.error = "Committed candidate unhealthy during recovery";
      }
    } else {
      journal.status = "failed";
      record.status = "failed";
      record.error = record.hooks.some(
        (h) =>
          h.startsWith("started:") &&
          !record.hooks.includes(h.replace("started:", "completed:")),
      )
        ? "Migration outcome uncertain; review database before redeploy"
        : "Interrupted deployment was not activated";
    }
    let recoveredHealthy = journal.status === "succeeded";
    if (journal.status === "failed") {
      let healthy = false;
      if (state.active)
        try {
          await this.check(
            state.active,
            (args) => this.run("/usr/bin/docker", args, { timeout: 30000 }),
            true,
          );
          healthy = true;
        } catch {
          /* keep maintenance */
        }
      recoveredHealthy = healthy;
      state.maintenance = healthy ? state.manualMaintenance : true;
      await this.publish(project, state, record.plan);
      if (record.plan && record.compose)
        await this.cleanup({
          id: record.id,
          plan: record.plan,
          compose: record.compose,
        }).catch(() => {});
    }
    delete state.pending;
    await this.save(project, state);
    record.events.push({
      phase: record.status,
      time: now(),
      message: record.error ?? "active release recovered",
    });
    await this.writeRecord(record);
    journal.error = record.error;
    journal.result = {
      ...this.outcome(state, record),
      state: recoveredHealthy
        ? "running"
        : state.active
          ? "degraded"
          : "failed",
    };
    await atomicWrite(this.journalPath(journal.id), JSON.stringify(journal));
    await rm(join(this.dir(project), "workspaces", journal.id), {
      recursive: true,
      force: true,
    });
  }
  async recover() {
    await this.legacy.restoreSecrets();
    for (const project of await readdir(this.root).catch(() => []))
      if (
        projectIdSchema.safeParse(project).success &&
        !(await exists(join(this.dir(project), "removed.json")))
      ) {
        await withProjectLock(join(this.root, ".locks", project), async () => {
          const state = await this.state(project);
          for (const id of await readdir(
            join(this.dir(project), "releases"),
          ).catch(() => []))
            if (projectIdSchema.safeParse(id).success) {
              const record = await this.record(project, id);
              if (record?.plan) {
                const vault = await this.releaseVault(project, id);
                await this.legacy.materialize(
                  {
                    ...record.plan,
                    services: record.plan.services.filter(
                      (s) => s.type === "postgres",
                    ),
                    builds: [],
                  },
                  vault,
                );
                await this.legacy.materialize(
                  record.plan,
                  vault,
                  this.secretBase(id),
                );
              }
            }
          if (state.pending) {
            const journal = await read<Journal>(
              this.journalPath(state.pending.operationId),
            );
            if (journal?.status === "running")
              await this.recoverProject(project, journal);
          }
          const current = await this.state(project);
          if (await exists(this.statePath(project)))
            await this.publish(project, current);
          await this.retention(project, current);
        }).catch((e) => {
          if ((e as { statusCode?: number }).statusCode !== 409) throw e;
        });
      }
  }
}
