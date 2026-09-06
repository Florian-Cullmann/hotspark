"use client";
import { useState } from "react";
import { HotsparkClient } from "../../../../packages/sdk/src/index";
import { applicationSpecSchema } from "../../../../packages/application-spec/src/index";
type Project = { id: string; name: string };
export default function Home() {
  const [token, setToken] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  function client() {
    return new HotsparkClient(window.location.origin, token);
  }
  return (
    <main>
      <header>
        <span className="logo">H</span>
        <div>
          <h1>Hotspark</h1>
          <p>Your server. Your applications.</p>
        </div>
        <span className="badge">Early stage · v0.1</span>
      </header>
      {!token ? (
        <section>
          <h2>Administration</h2>
          <p>
            Sign in with the administrator credentials generated during
            installation.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void action(async () => {
                const response = await fetch("/api/v1/auth/login", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    email: data.get("email"),
                    password: data.get("password"),
                  }),
                });
                const body = await response.json();
                if (!response.ok)
                  throw new Error(body.error?.message ?? "Sign-in failed");
                setToken(body.token);
                setProjects(
                  await new HotsparkClient(
                    window.location.origin,
                    body.token,
                  ).projects(),
                );
              });
            }}
          >
            <label>
              Email
              <input
                name="email"
                type="email"
                defaultValue="admin@localhost"
                required
                autoComplete="username"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
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
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => setProjects(await client().projects()))
              }
            >
              Refresh
            </button>
            <button
              onClick={() => {
                setToken("");
                setProjects([]);
              }}
            >
              Clear session
            </button>
          </nav>
          <section>
            <h2>Projects</h2>
            {projects.length === 0 ? (
              <p>No projects yet. Create one from an ApplicationSpec below.</p>
            ) : (
              projects.map((project) => (
                <article key={project.id}>
                  <div>
                    <h3>{project.name}</h3>
                    <code>{project.id}</code>
                  </div>
                  <div className="actions">
                    {(["deploy", "start", "stop"] as const).map((operation) => (
                      <button
                        key={operation}
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            const job = await client().request<{ id: string }>(
                              `projects/${project.id}/${operation}`,
                              { method: "POST" },
                            );
                            setMessage(
                              `Job ${job.id} queued. Use “Jobs” to inspect progress.`,
                            );
                          })
                        }
                      >
                        {operation}
                      </button>
                    ))}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const jobs = await client().request<
                            { id: string; status: string }[]
                          >(`projects/${project.id}/jobs`);
                          setMessage(
                            jobs
                              .map((j) => `${j.id}: ${j.status}`)
                              .join("\n") || "No jobs",
                          );
                        })
                      }
                    >
                      Jobs
                    </button>
                  </div>
                </article>
              ))
            )}
          </section>
          <section>
            <h2>Create a project</h2>
            <p>
              Paste a v1 ApplicationSpec as JSON. Images must be pinned by
              SHA-256 digest.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void action(async () => {
                  const spec = applicationSpecSchema.parse(
                    JSON.parse(String(data.get("spec"))),
                  );
                  await client().createProject(spec);
                  setProjects(await client().projects());
                  setMessage("Project created. Deploy it when ready.");
                });
              }}
            >
              <label>
                ApplicationSpec
                <textarea
                  name="spec"
                  rows={12}
                  required
                  placeholder={
                    '{"apiVersion":"hotspark.dev/v1","kind":"Application", ...}'
                  }
                />
              </label>
              <button disabled={busy}>Create project</button>
            </form>
          </section>
        </>
      )}
      <pre role="status" aria-live="polite">
        {busy ? "Working…" : message}
      </pre>
      <footer>
        Hotspark is experimental. Back up your server and application data.
      </footer>
    </main>
  );
}
