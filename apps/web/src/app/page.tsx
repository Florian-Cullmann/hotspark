"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  HotsparkClient,
  type Project,
  type JobReference,
} from "../../../../packages/sdk/src/index";
import { applicationSpecSchema } from "../../../../packages/application-spec/src/index";
import { Deployments } from "../components/deployments";
type Dashboard = {
  health: string;
  counts: Record<string, number>;
  host: {
    memory: { total: number; free: number };
    cpu: { count: number; load: number[] };
    disk: { available: number };
  } | null;
};
type Job = {
  id: string;
  status: string;
  progress: number;
  error: string | null;
  events: { message: string }[];
};
export default function Home() {
  const [token, setToken] = useState(""),
    [route, setRoute] = useState("dashboard"),
    [projects, setProjects] = useState<Project[]>([]),
    [dashboard, setDashboard] = useState<Dashboard | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("overview"),
    [logs, setLogs] = useState(""),
    [job, setJob] = useState<Job | null>(null),
    [jobId, setJobId] = useState("");
  const [advancedMode, setAdvancedMode] = useState(false);
  const api = useCallback(
    () => new HotsparkClient(window.location.origin, token),
    [token],
  );
  const releaseClient = useMemo(
    () =>
      new HotsparkClient(
        typeof window === "undefined"
          ? "http://localhost"
          : window.location.origin,
        token,
      ),
    [token],
  );
  const refresh = useCallback(async () => {
    const client = api();
    const [p, d] = await Promise.all([
      client.projects(),
      client.request<Dashboard>("dashboard"),
    ]);
    setProjects(p);
    setDashboard(d);
  }, [api]);
  useEffect(() => {
    const change = () => setRoute(window.location.hash.slice(1) || "dashboard");
    change();
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (!token) return;
    const update = () => void refresh().catch((e) => setMessage(String(e)));
    update();
    const timer = setInterval(update, 10000);
    return () => clearInterval(timer);
  }, [token, refresh]);
  useEffect(() => {
    if (!token || !jobId) return;
    let active = true;
    const poll = async () => {
      try {
        const result = await api().job(jobId);
        if (active) {
          setJob(result);
          if (["succeeded", "failed", "cancelled"].includes(result.status)) {
            clearInterval(timer);
            await refresh();
          }
        }
      } catch (e) {
        if (active) setMessage(String(e));
      }
    };
    const timer = setInterval(() => void poll(), 3000);
    void poll();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [token, jobId, api, refresh]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  const track = (ref: JobReference) => {
    setJobId(ref.jobId);
    setJob(null);
    setMessage(`Job ${ref.jobId} queued`);
  };
  const selected = projects.find((p) => route === `projects/${p.id}`);
  async function control(project: Project, operation: string) {
    if (
      operation === "delete" &&
      !window.confirm(
        "Remove this project’s containers and routes? Persistent data and encrypted secrets will be retained.",
      )
    )
      return;
    await action(async () => {
      track(
        await api().request<JobReference>(
          `projects/${project.id}${operation === "delete" ? "" : `/${operation}`}`,
          {
            method: operation === "delete" ? "DELETE" : "POST",
            headers: { "Idempotency-Key": crypto.randomUUID() },
          },
        ),
      );
    });
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action(async () => {
      const type = String(form.get("type")),
        name = String(form.get("name")),
        pm = String(form.get("packageManager"));
      const command = (key: string) =>
        String(form.get(key) || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
      const build = {
        nodeVersion: form.get("nodeVersion"),
        packageManager: pm,
        standalone: form.get("standalone") === "on",
        outputDirectory: String(form.get("outputDirectory") || "dist"),
        ...(command("installCommand").length
          ? { installCommand: command("installCommand") }
          : {}),
        ...(command("buildCommand").length
          ? { buildCommand: command("buildCommand") }
          : {}),
        ...(command("startCommand").length
          ? { startCommand: command("startCommand") }
          : {}),
      };
      const vars = JSON.parse(String(form.get("environment") || "{}"));
      const secretValues = JSON.parse(String(form.get("secrets") || "{}"));
      const database = form.get("database") === "on" && type !== "react";
      const draft = {
        apiVersion: "hotspark.dev/v1",
        kind: "Application",
        metadata: { name },
        services: {
          web: {
            type,
            source: {
              type: "git",
              repository: form.get("repository"),
              commit: form.get("commit"),
            },
            build,
            runtime: { port: Number(form.get("port")) },
            domains: String(form.get("domains") || "")
              .split(/[\s,]+/)
              .filter(Boolean),
            environment: vars,
            secrets: Object.keys(secretValues),
            ...(database ? { database: "database" } : {}),
            hooks:
              form.get("migrate") === "on"
                ? [{ type: "prisma-migrate-deploy" }]
                : [],
          },
          ...(database
            ? {
                database: {
                  type: "postgres",
                  version: form.get("postgresVersion"),
                },
              }
            : {}),
        },
      };
      const advanced = advancedMode
        ? String(form.get("advanced") || "").trim()
        : "";
      const spec = applicationSpecSchema.parse(
        advanced ? JSON.parse(advanced) : draft,
      );
      const secrets = advanced
        ? JSON.parse(String(form.get("advancedSecrets") || "{}"))
        : { web: secretValues };
      const ref = await api().createProject(spec, secrets, crypto.randomUUID());
      track(ref);
      await refresh();
      window.location.hash = `projects/${ref.projectId}`;
    });
  }
  return (
    <main>
      <header>
        <a className="logo" href="#dashboard">
          H
        </a>
        <div>
          <h1>Hotspark</h1>
          <p>Isolated applications on your server</p>
        </div>
        <span className="badge">Early stage · v0.3</span>
      </header>
      {!token ? (
        <section>
          <h2>Administration</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void action(async () => {
                const response = await fetch("/api/v1/auth/login", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    email: form.get("email"),
                    password: form.get("password"),
                  }),
                });
                const result = await response.json();
                if (!response.ok)
                  throw new Error(result.error?.message ?? "Login failed");
                setToken(result.token);
              });
            }}
          >
            <label>
              Email
              <input
                type="email"
                name="email"
                defaultValue="admin@localhost"
                required
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                name="password"
                required
                autoComplete="current-password"
              />
            </label>
            <button disabled={busy}>Sign in</button>
          </form>
        </section>
      ) : (
        <>
          <nav>
            <a href="#dashboard">Dashboard</a>
            <a href="#projects">Projects</a>
            <a href="#create">Create project</a>
            <button
              onClick={() => {
                setToken("");
                setJobId("");
                setProjects([]);
              }}
            >
              Clear session
            </button>
          </nav>
          {route === "dashboard" && (
            <>
              <h2>Dashboard</h2>
              <div className="cards">
                <section>
                  <h3>Platform</h3>
                  <strong>{dashboard?.health ?? "Loading"}</strong>
                </section>
                {[
                  "running",
                  "stopped",
                  "failed",
                  "provisioning",
                  "building",
                  "degraded",
                ].map((state) => (
                  <section key={state}>
                    <h3>{state}</h3>
                    <strong>{dashboard?.counts[state] ?? 0}</strong>
                  </section>
                ))}
              </div>
              {dashboard?.host && (
                <section>
                  <h3>Host resources</h3>
                  <p>
                    {dashboard.host.cpu.count} CPUs · load{" "}
                    {dashboard.host.cpu.load
                      .map((n) => n.toFixed(2))
                      .join(" / ")}
                  </p>
                  <p>
                    Memory:{" "}
                    {(
                      (dashboard.host.memory.total -
                        dashboard.host.memory.free) /
                      2 ** 30
                    ).toFixed(1)}{" "}
                    / {(dashboard.host.memory.total / 2 ** 30).toFixed(1)} GiB ·
                    Disk available:{" "}
                    {(dashboard.host.disk.available / 2 ** 30).toFixed(1)} GiB
                  </p>
                  <p>
                    Disk usage is informational; disk quotas are not enforced.
                  </p>
                </section>
              )}
            </>
          )}
          {route === "projects" && (
            <section>
              <h2>Projects</h2>
              {!projects.length && (
                <p>
                  No projects yet. Create an application stack to get started.
                </p>
              )}
              {projects.map((p) => (
                <article key={p.id}>
                  <div>
                    <h3>
                      <a href={`#projects/${p.id}`}>{p.name}</a>
                    </h3>
                    <p>
                      {p.observedState} · desired {p.desiredState}
                    </p>
                    <p>{Object.keys(p.spec.services).join(", ")}</p>
                    <small>
                      {Object.values(p.spec.services)
                        .flatMap((s) =>
                          s.type === "postgres" ? [] : s.domains,
                        )
                        .join(", ") || "No public domains"}
                    </small>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void control(
                        p,
                        p.desiredState === "stopped" ? "start" : "stop",
                      )
                    }
                  >
                    {p.desiredState === "stopped" ? "Start" : "Stop"}
                  </button>
                </article>
              ))}
            </section>
          )}
          {selected && (
            <>
              <h2>{selected.name}</h2>
              <p>
                {selected.observedState} · desired {selected.desiredState}
              </p>
              <div className="actions">
                {["start", "stop", "restart", "delete"].map((op) => (
                  <button
                    disabled={busy}
                    key={op}
                    onClick={() => void control(selected, op)}
                  >
                    {op}
                  </button>
                ))}
              </div>
              <nav>
                {[
                  "overview",
                  "services",
                  "environment",
                  "domains",
                  "logs",
                  "settings",
                  "deployments",
                ].map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    aria-pressed={tab === t}
                  >
                    {t}
                  </button>
                ))}
              </nav>
              {tab === "overview" && (
                <section>
                  <h3>Overview</h3>
                  <code>{selected.id}</code>
                  <p>
                    {Object.keys(selected.spec.services).length} services ·
                    automatic restart after drift:{" "}
                    {selected.restoreOnDrift ? "on" : "off"}
                  </p>
                  <p>
                    Runtime version {selected.runtimeVersion}. Deletion
                    preserves volumes and encrypted secrets.
                  </p>
                </section>
              )}
              {(tab === "overview" || tab === "deployments") && (
                <Deployments
                  client={releaseClient}
                  project={selected}
                  compact={tab === "overview"}
                  onChange={refresh}
                />
              )}
              {tab === "services" && (
                <section>
                  <h3>Services</h3>
                  {Object.entries(selected.spec.services).map(([name, s]) => (
                    <article key={name}>
                      <h3>{name}</h3>
                      <p>
                        {s.type} · {s.resources.memoryMb} MiB /{" "}
                        {s.resources.cpus} CPU
                      </p>
                      <p>
                        {s.type === "postgres"
                          ? "Private database"
                          : s.database
                            ? `Connected to ${s.database}`
                            : "HTTP application"}
                      </p>
                    </article>
                  ))}
                </section>
              )}
              {tab === "environment" && (
                <section>
                  <h3>Environment and secrets</h3>
                  <p>
                    Secret values are never returned. Enter a value to replace
                    it on the next deployment.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void action(async () => {
                        const service = String(f.get("service"));
                        const spec = structuredClone(selected.spec);
                        const s = spec.services[service];
                        if (!s || s.type === "postgres")
                          throw new Error("Select an application service");
                        s.environment = JSON.parse(
                          String(f.get("environment")),
                        );
                        const values = JSON.parse(
                          String(f.get("secrets") || "{}"),
                        );
                        s.secrets = [
                          ...new Set([...s.secrets, ...Object.keys(values)]),
                        ];
                        track(
                          await api().request<JobReference>(
                            `projects/${selected.id}`,
                            {
                              method: "PATCH",
                              body: JSON.stringify({
                                spec,
                                secrets: { [service]: values },
                              }),
                            },
                          ),
                        );
                      });
                    }}
                  >
                    <label>
                      Service
                      <select name="service">
                        {Object.entries(selected.spec.services)
                          .filter(([, s]) => s.type !== "postgres")
                          .map(([name]) => (
                            <option key={name}>{name}</option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Normal environment JSON (replaces the selected service’s
                      environment)
                      <textarea name="environment" defaultValue="{}" required />
                    </label>
                    <label>
                      Secret replacements JSON
                      <input
                        name="secrets"
                        type="password"
                        placeholder='{"API_KEY":"new value"}'
                        autoComplete="off"
                      />
                    </label>
                    <button disabled={busy}>Save and deploy</button>
                  </form>
                  <pre>
                    {JSON.stringify(
                      Object.fromEntries(
                        Object.entries(selected.spec.services)
                          .filter(([, s]) => s.type !== "postgres")
                          .map(([name, s]) => [
                            name,
                            s.type === "postgres"
                              ? {}
                              : {
                                  environment: s.environment,
                                  secrets: s.secrets.map(
                                    (k) => `${k}: [configured]`,
                                  ),
                                },
                          ]),
                      ),
                      null,
                      2,
                    )}
                  </pre>
                </section>
              )}
              {tab === "domains" && (
                <section>
                  <h3>Domains</h3>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void action(async () =>
                        track(
                          await api().request<JobReference>(
                            `projects/${selected.id}/domains`,
                            {
                              method: "PUT",
                              body: JSON.stringify({
                                service: f.get("service"),
                                domains: String(f.get("domains"))
                                  .split(/[\s,]+/)
                                  .filter(Boolean),
                              }),
                            },
                          ),
                        ),
                      );
                    }}
                  >
                    <label>
                      Service
                      <select name="service">
                        {Object.entries(selected.spec.services)
                          .filter(([, s]) => s.type !== "postgres")
                          .map(([name]) => (
                            <option key={name}>{name}</option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Domains (replaces the selected service’s domains)
                      <textarea name="domains" placeholder="app.example.com" />
                    </label>
                    <button disabled={busy}>Save and deploy</button>
                  </form>
                  <p>
                    {Object.values(selected.spec.services)
                      .flatMap((s) => (s.type === "postgres" ? [] : s.domains))
                      .join(", ")}
                  </p>
                </section>
              )}
              {tab === "logs" && (
                <section>
                  <h3>Application logs</h3>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void action(async () => {
                        const result = await api().request<{ text: string }>(
                          `projects/${selected.id}/logs?service=${encodeURIComponent(String(f.get("service")))}&lines=200&stream=${f.get("stream")}`,
                        );
                        setLogs(result.text);
                      });
                    }}
                  >
                    <label>
                      Service
                      <select name="service">
                        {Object.keys(selected.spec.services).map((name) => (
                          <option key={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Stream
                      <select name="stream">
                        <option>both</option>
                        <option>stdout</option>
                        <option>stderr</option>
                      </select>
                    </label>
                    <button disabled={busy}>Load latest 200 lines</button>
                  </form>
                  <pre>{logs}</pre>
                </section>
              )}
              {tab === "settings" && (
                <section>
                  <h3>Application specification</h3>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void action(async () => {
                        const spec = applicationSpecSchema.parse(
                          JSON.parse(String(f.get("spec"))),
                        );
                        track(
                          await api().request<JobReference>(
                            `projects/${selected.id}`,
                            {
                              method: "PATCH",
                              body: JSON.stringify({
                                spec,
                                restoreOnDrift: f.get("restore") === "on",
                              }),
                            },
                          ),
                        );
                      });
                    }}
                  >
                    <textarea
                      name="spec"
                      rows={22}
                      defaultValue={JSON.stringify(selected.spec, null, 2)}
                      key={selected.id}
                    />
                    <label>
                      <input
                        type="checkbox"
                        name="restore"
                        defaultChecked={selected.restoreOnDrift}
                      />{" "}
                      Restore stopped containers when desired state is running
                    </label>
                    <button disabled={busy || selected.runtimeVersion < 2}>
                      Save and deploy
                    </button>
                  </form>
                  {selected.runtimeVersion < 2 && (
                    <p>
                      Legacy deployment: explicit migration is required before
                      editing its resource layout.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
          {route === "create" && (
            <section>
              <h2>Create a project</h2>
              <form onSubmit={(e) => void create(e)}>
                <div className="fields">
                  <label>
                    Project name
                    <input
                      name="name"
                      required={!advancedMode}
                      pattern="[a-z][a-z0-9-]{0,39}"
                      placeholder="my-application"
                    />
                  </label>
                  <label>
                    Provider
                    <select name="type">
                      <option value="nextjs">Next.js</option>
                      <option value="node">Node.js</option>
                      <option value="react">React / Vite static</option>
                    </select>
                  </label>
                  <label>
                    GitHub HTTPS repository
                    <input
                      name="repository"
                      placeholder="https://github.com/organization/application.git"
                      required={!advancedMode}
                    />
                  </label>
                  <label>
                    Full Git commit
                    <input
                      name="commit"
                      pattern="[a-f0-9]{40}"
                      required={!advancedMode}
                    />
                  </label>
                  <label>
                    Node.js
                    <select name="nodeVersion">
                      <option>24</option>
                      <option>22</option>
                    </select>
                  </label>
                  <label>
                    Package manager
                    <select name="packageManager">
                      <option>npm</option>
                      <option>pnpm</option>
                      <option>yarn</option>
                    </select>
                  </label>
                  <label>
                    Install command
                    <input
                      name="installCommand"
                      placeholder="Provider default (frozen lockfile)"
                    />
                  </label>
                  <label>
                    Build command
                    <input name="buildCommand" placeholder="npm run build" />
                  </label>
                  <label>
                    Start command
                    <input name="startCommand" placeholder="npm run start" />
                  </label>
                  <label>
                    Runtime port
                    <input
                      name="port"
                      type="number"
                      min="1024"
                      max="65535"
                      defaultValue="3000"
                    />
                  </label>
                  <label>
                    Static output directory
                    <input name="outputDirectory" defaultValue="dist" />
                  </label>
                  <label>
                    Domains
                    <input
                      name="domains"
                      placeholder="app.example.com, www.example.com"
                    />
                  </label>
                </div>
                <label>
                  <input type="checkbox" name="standalone" /> Use Next.js
                  standalone output (repository must enable it)
                </label>
                <label>
                  <input type="checkbox" name="database" defaultChecked /> Add a
                  private PostgreSQL database and inject DATABASE_URL
                </label>
                <label>
                  PostgreSQL version
                  <select name="postgresVersion">
                    <option>17</option>
                    <option>16</option>
                    <option>18</option>
                  </select>
                </label>
                <label>
                  <input type="checkbox" name="migrate" /> Run Prisma migrate
                  deploy before starting the application
                </label>
                <label>
                  Normal environment JSON
                  <textarea name="environment" defaultValue="{}" />
                </label>
                <label>
                  Secret values JSON for web
                  <input
                    type="password"
                    name="secrets"
                    autoComplete="off"
                    placeholder='{"API_KEY":"value"}'
                  />
                </label>
                <details>
                  <summary>
                    Advanced ApplicationSpec — all API capabilities
                  </summary>
                  <label>
                    <input
                      type="checkbox"
                      checked={advancedMode}
                      onChange={(e) => setAdvancedMode(e.target.checked)}
                    />
                    Use this JSON specification
                  </label>
                  <p>
                    The complete JSON spec below replaces the wizard definition.
                  </p>
                  <textarea
                    name="advanced"
                    rows={15}
                    placeholder="Full ApplicationSpec JSON"
                  />
                  <label>
                    Advanced secrets by service (JSON)
                    <input
                      type="password"
                      name="advancedSecrets"
                      autoComplete="off"
                      placeholder='{"web":{"API_KEY":"value"}}'
                    />
                  </label>
                </details>
                <button disabled={busy}>Create and provision</button>
              </form>
            </section>
          )}
          {jobId && (
            <section>
              <h3>Deployment job</h3>
              <code>{jobId}</code>
              <p>
                {job?.status ?? "queued"} · {job?.progress ?? 0}%
              </p>
              <progress max="100" value={job?.progress ?? 0} />
              <pre>
                {job?.events.map((e) => e.message).join("\n")}
                {job?.error && `\n${job.error}`}
              </pre>
              {job?.status === "queued" && (
                <button
                  onClick={() =>
                    void action(async () => {
                      await api().request(`jobs/${jobId}/cancel`, {
                        method: "POST",
                      });
                      setMessage("Cancellation requested");
                    })
                  }
                >
                  Cancel queued job
                </button>
              )}
            </section>
          )}
        </>
      )}
      <pre role="status" aria-live="polite">
        {busy ? "Working…" : message}
      </pre>
      <footer>
        Experimental software. Back up your application data. Docker isolation
        is not a VM boundary.
      </footer>
    </main>
  );
}
