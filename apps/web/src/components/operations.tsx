"use client";
import { useEffect, useState } from "react";
import type { HotsparkClient } from "../../../../packages/sdk/src/index";
type Task = {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  error: string | null;
  result: unknown;
};
type Check = { name: string; status: string; detail: string };
type Report = {
  version: string;
  checks: Check[];
  databaseBytes: number;
  host: {
    checks: Check[];
    storage: unknown;
    memory: { total: number; free: number };
    cpu: { count: number; load: number[] };
    disk: { available: number; total: number };
  } | null;
};
export function SystemOperations({ client }: { client: HotsparkClient }) {
  const [report, setReport] = useState<Report | null>(null),
    [tasks, setTasks] = useState<Task[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    const [r, t] = await Promise.all([
      client.request<Report>("system/doctor"),
      client.request<Task[]>("system/tasks"),
    ]);
    setReport(r);
    setTasks(t);
  };
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [r, t] = await Promise.all([
          client.request<Report>("system/doctor"),
          client.request<Task[]>("system/tasks"),
        ]);
        if (alive) {
          setReport(r);
          setTasks(t);
        }
      } catch {
        if (alive) setError("System diagnostics unavailable");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client]);
  async function submit(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await client.request(path, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      await refresh();
    } catch {
      setError(
        "Operation could not be queued. Check permissions and existing tasks.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>System</h2>
      <p>
        Installed API version: {report?.version ?? "Loading"}. Diagnostics
        refresh every 30 seconds.
      </p>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Status</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {[...(report?.checks ?? []), ...(report?.host?.checks ?? [])].map(
            (c, i) => (
              <tr key={`${c.name}-${i}`}>
                <td>{c.name}</td>
                <td>{c.status}</td>
                <td>{c.detail}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {report?.host && (
        <p>
          {report.host.cpu.count} CPUs · memory available{" "}
          {(report.host.memory.free / 2 ** 30).toFixed(1)} GiB · disk available{" "}
          {(report.host.disk.available / 2 ** 30).toFixed(1)} GiB · platform
          database {(report.databaseBytes / 2 ** 20).toFixed(1)} MiB
        </p>
      )}
      <h3>Storage</h3>
      <pre>
        {JSON.stringify(report?.host?.storage ?? "Unavailable", null, 2)}
      </pre>
      <h3>Backups</h3>
      <p>
        Backups stay on this host in a root-only directory. Copy them off-host
        and perform a restore drill.
      </p>
      <button disabled={busy} onClick={() => void submit("system/backups", {})}>
        Create platform backup
      </button>
      <h3>Versioned update</h3>
      <p>
        The administrator must configure a trusted release origin on the host.
        Hosted application data is preserved. Review migration compatibility
        first.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          if (
            confirm(
              "Update platform services after taking a database backup? Administration will briefly disconnect.",
            )
          )
            void submit("system/updates", {
              version: f.get("version"),
              sha256: f.get("sha256"),
            });
        }}
      >
        <label>
          Target version
          <input
            name="version"
            placeholder="0.4.1"
            required
            pattern="[0-9]+\.[0-9]+\.[0-9]+"
          />
        </label>
        <label>
          Trusted archive SHA-256
          <input name="sha256" required pattern="[a-f0-9]{64}" />
        </label>
        <button disabled={busy}>Queue update</button>
      </form>
      <h3>Operational tasks</h3>
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Created</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                {t.kind}
                <br />
                <small>{t.id}</small>
              </td>
              <td>{t.status}</td>
              <td>{new Date(t.createdAt).toLocaleString()}</td>
              <td>
                <details>
                  <summary>Details</summary>
                  <pre>{JSON.stringify(t.result ?? t.error, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
export function ProjectBackup({
  client,
  projectId,
}: {
  client: HotsparkClient;
  projectId: string;
}) {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section>
      <h3>Project backup</h3>
      <p>
        Creates PostgreSQL logical dumps and recovery metadata. Application
        images and other volume types are excluded.
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const task = await client.request<{ taskId: string }>(
              "system/backups",
              {
                method: "POST",
                headers: { "Idempotency-Key": crypto.randomUUID() },
                body: JSON.stringify({ projectId }),
              },
            );
            setMessage(`Queued ${task.taskId}. Follow its result on System.`);
          } catch {
            setMessage("Backup could not be queued");
          } finally {
            setBusy(false);
          }
        }}
      >
        Create project backup
      </button>
      <p role="status">{message}</p>
    </section>
  );
}

export function ProjectResources({
  client,
  projectId,
}: {
  client: HotsparkClient;
  projectId: string;
}) {
  const [usage, setUsage] = useState<unknown>(null);
  return (
    <section>
      <h3>Runtime resource usage</h3>
      <button
        onClick={async () => {
          try {
            setUsage(await client.request(`projects/${projectId}/usage`));
          } catch {
            setUsage("Resource inspection unavailable");
          }
        }}
      >
        Refresh resource usage
      </button>
      <pre>{JSON.stringify(usage, null, 2)}</pre>
    </section>
  );
}
