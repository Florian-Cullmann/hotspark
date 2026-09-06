"use client";
import { useEffect, useState, useCallback } from "react";
import {
  HotsparkClient,
  type Project,
} from "../../../../packages/sdk/src/index";
interface Release {
  id: string;
  status: string;
  actorId: string | null;
  tokenId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  previousReleaseId: string | null;
  rollbackOfId: string | null;
  sources:
    | {
        service: string;
        repository: string;
        branch?: string;
        tag?: string;
        commit?: string;
      }[]
    | null;
  images: { service: string; reference: string; digest: string }[] | null;
  error: string | null;
  runtime?: {
    events: { phase: string; time: string; message: string }[];
    health: { service: string; healthy: boolean }[];
  } | null;
}
export function Deployments({
  client,
  project,
  compact = false,
  onChange,
}: {
  client: HotsparkClient;
  project: Project;
  compact?: boolean;
  onChange: () => Promise<void>;
}) {
  const [releases, setReleases] = useState<Release[]>([]),
    [selected, setSelected] = useState<string>(""),
    [detail, setDetail] = useState<Release | null>(null),
    [logs, setLogs] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<string>("");
  const base = client.base;
  const refresh = useCallback(async () => {
    setReleases(
      await client.request<Release[]>(`projects/${project.id}/deployments`),
    );
    if (selected)
      setDetail(await client.request<Release>(`deployments/${selected}`));
  }, [client, project.id, selected]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(String(e))),
      5000,
    );
    return () => clearInterval(timer);
  }, [refresh, base]);
  async function action(path: string, method = "POST", body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await client.request<{ jobId?: string }>(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      setJob(result.jobId ?? "");
      await refresh();
      await onChange();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!job) return;
    const timer = setInterval(() => {
      void client
        .job(job)
        .then(async (j) => {
          if (["succeeded", "failed", "cancelled"].includes(j.status)) {
            clearInterval(timer);
            setJob("");
            if (j.error) setError(j.error);
            await refresh();
            await onChange();
          }
        })
        .catch((e) => setError(String(e)));
    }, 3000);
    return () => clearInterval(timer);
  }, [job, client, refresh, onChange]);
  return (
    <section>
      <h3>{compact ? "Active release" : "Deployments"}</h3>
      <p>{project.activeDeploymentId ?? "No active release"}</p>
      <p>
        Maintenance: {project.maintenanceObserved ? "enabled" : "disabled"} ·
        Health: {project.observedState}
      </p>
      <button
        disabled={busy || !!job || project.runtimeVersion < 2}
        onClick={() =>
          void action(`projects/${project.id}/maintenance`, "PUT", {
            enabled: !project.maintenanceEnabled,
          })
        }
      >
        {project.maintenanceEnabled
          ? "Disable maintenance"
          : "Enable maintenance"}
      </button>
      <button
        disabled={busy || !!job || project.runtimeVersion < 2}
        onClick={() => void action(`projects/${project.id}/deployments`)}
      >
        Deploy new release
      </button>
      {job && <p role="status">Job {job} is running.</p>}
      {error && <p role="alert">{error}</p>}
      {!compact && (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Release</th>
                  <th>Status</th>
                  <th>Commit / ref</th>
                  <th>Duration</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        onClick={() => {
                          setSelected(r.id);
                          setLogs("");
                        }}
                      >
                        {r.id.slice(0, 8)}
                      </button>
                      {r.id === project.activeDeploymentId && " Active"}
                    </td>
                    <td>{r.status}</td>
                    <td>
                      {r.sources?.map((s) => (
                        <div key={s.service}>
                          {s.commit?.slice(0, 12) ?? "unresolved"} ·{" "}
                          {s.branch ?? s.tag ?? "commit"}
                        </div>
                      ))}
                    </td>
                    <td>
                      {r.startedAt
                        ? `${Math.round(((r.finishedAt ? Date.parse(r.finishedAt) : Date.now()) - Date.parse(r.startedAt)) / 1000)}s`
                        : "queued"}
                    </td>
                    <td>
                      {r.actorId ?? "legacy"}
                      {r.tokenId && (
                        <small> · token {r.tokenId.slice(0, 8)}</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail && (
            <article>
              <h3>Release {detail.id}</h3>
              <p>
                {detail.status}
                {detail.error && ` · ${detail.error}`}
              </p>
              <p>
                Previous: {detail.previousReleaseId ?? "none"} · Rollback
                target: {detail.rollbackOfId ?? "none"}
              </p>
              <button
                disabled={
                  busy ||
                  !!job ||
                  !detail.runtime ||
                  !["active", "superseded", "rolled_back"].includes(
                    detail.status,
                  )
                }
                onClick={() => {
                  if (
                    window.confirm(
                      "Roll back application images? Database migrations will not be reversed.",
                    )
                  )
                    void action(`projects/${project.id}/rollbacks`, "POST", {
                      deploymentId: detail.id,
                    });
                }}
              >
                Roll back to these images
              </button>
              {["cloning", "building", "built"].includes(detail.status) && (
                <button
                  disabled={busy}
                  onClick={() => void action(`deployments/${detail.id}/cancel`)}
                >
                  Cancel build
                </button>
              )}
              <h4>Timeline</h4>
              <ol>
                {detail.runtime?.events?.map((e, i) => (
                  <li key={i}>
                    <time>{new Date(e.time).toLocaleTimeString()}</time> ·{" "}
                    {e.message}
                  </li>
                ))}
              </ol>
              <h4>Health verification</h4>
              {detail.runtime?.health?.map((h) => (
                <p key={h.service}>
                  {h.service}: {h.healthy ? "passed" : "failed"}
                </p>
              ))}
              <h4>Images</h4>
              {detail.images?.map((i) => (
                <p key={i.service}>
                  {i.service}: <code>{i.digest}</code>
                </p>
              ))}
              <button
                onClick={() =>
                  void client
                    .request<{ logs: string }>(`deployments/${detail.id}/logs`)
                    .then((r) => setLogs(r.logs))
                    .catch((e) => setError(String(e)))
                }
              >
                Load build and migration logs
              </button>
              <pre>{logs}</pre>
            </article>
          )}
        </>
      )}
    </section>
  );
}
