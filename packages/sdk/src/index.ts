import type { ApplicationSpec } from "../../application-spec/src/index.js";
export class HotsparkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
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
    if (!response.ok)
      throw new Error(
        `Hotspark request failed (${response.status}): ${await response.text()}`,
      );
    return response.status === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
  projects() {
    return this.request<{ id: string; name: string; spec: ApplicationSpec }[]>(
      "projects",
    );
  }
  createProject(spec: ApplicationSpec) {
    return this.request<{ id: string }>("projects", {
      method: "POST",
      body: JSON.stringify(spec),
    });
  }
  deploy(id: string) {
    return this.request<{ id: string; status: string }>(
      `projects/${encodeURIComponent(id)}/deploy`,
      { method: "POST" },
    );
  }
  job(id: string) {
    return this.request<{ id: string; status: string; error: string | null }>(
      `jobs/${encodeURIComponent(id)}`,
    );
  }
}
