import type { ApplicationSpec } from "../../application-spec/src/index.js";
export interface JobReference {
  projectId: string;
  jobId: string;
  deploymentId?: string;
  job: { id: string; status: string };
}
export interface Project {
  id: string;
  name: string;
  spec: ApplicationSpec;
  desiredState: string;
  observedState: string;
  restoreOnDrift: boolean;
  runtimeVersion: number;
  activeDeploymentId?: string | null;
  maintenanceEnabled?: boolean;
  maintenanceObserved?: boolean;
}
export class HotsparkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
  get base() {
    return this.baseUrl;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(`/api/v1/${path}`, this.baseUrl), {
      ...init,
      headers: {
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        authorization: `Bearer ${this.token}`,
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({ error: { message: "Request failed" } }));
      throw new Error(
        `${response.status}: ${body.error?.message ?? "Request failed"}`,
      );
    }
    return response.status === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
  projects() {
    return this.request<Project[]>("projects");
  }
  createProject(
    spec: ApplicationSpec,
    secrets: Record<string, Record<string, string>> = {},
    idempotencyKey?: string,
  ) {
    return this.request<JobReference>("projects", {
      method: "POST",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      body: JSON.stringify({ spec, secrets }),
    });
  }
  deploy(id: string, idempotencyKey?: string) {
    return this.request<JobReference>(
      `projects/${encodeURIComponent(id)}/deployments`,
      {
        method: "POST",
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      },
    );
  }
  rollback(id: string, deploymentId: string, idempotencyKey?: string) {
    return this.request<JobReference>(
      `projects/${encodeURIComponent(id)}/rollbacks`,
      {
        method: "POST",
        body: JSON.stringify({ deploymentId }),
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      },
    );
  }
  maintenance(id: string, enabled: boolean, idempotencyKey?: string) {
    return this.request<JobReference>(
      `projects/${encodeURIComponent(id)}/maintenance`,
      {
        method: "PUT",
        body: JSON.stringify({ enabled }),
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
      },
    );
  }
  job(id: string) {
    return this.request<{
      id: string;
      status: string;
      progress: number;
      error: string | null;
      events: { message: string }[];
    }>(`jobs/${encodeURIComponent(id)}`);
  }
}
