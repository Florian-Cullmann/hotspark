// Enrich documentation without changing Fastify response serialization/public behavior.
export function publicOpenAPI(input: unknown) {
  const doc = structuredClone(input) as {
    components: { schemas?: Record<string, unknown> };
    paths: Record<
      string,
      Record<
        string,
        {
          operationId?: string;
          parameters?: unknown[];
          responses?: Record<string, unknown>;
        }
      >
    >;
  };
  const uuid = { type: "string", format: "uuid" };
  doc.components.schemas = {
    ...doc.components.schemas,
    Project: {
      type: "object",
      required: ["id", "name", "spec", "desiredState", "observedState"],
      properties: {
        id: uuid,
        name: { type: "string" },
        spec: {
          type: "object",
          description:
            "Validated hotspark.dev/v1 ApplicationSpec; see create request schema",
        },
        desiredState: {
          type: "string",
          enum: ["running", "stopped", "deleted"],
        },
        observedState: { type: "string" },
        activeDeploymentId: { ...uuid, nullable: true },
        maintenanceEnabled: { type: "boolean" },
        maintenanceObserved: { type: "boolean" },
      },
    },
    JobReference: {
      type: "object",
      required: ["projectId", "jobId"],
      properties: { projectId: uuid, jobId: uuid, deploymentId: uuid },
    },
    Job: {
      type: "object",
      required: ["id", "status", "progress"],
      properties: {
        id: uuid,
        projectId: uuid,
        deploymentId: { ...uuid, nullable: true },
        status: {
          type: "string",
          enum: ["queued", "running", "succeeded", "failed", "cancelled"],
        },
        progress: { type: "integer", minimum: 0, maximum: 100 },
        error: { type: "string", nullable: true },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              message: { type: "string" },
              progress: { type: "integer" },
            },
          },
        },
      },
    },
    TaskReference: {
      type: "object",
      required: ["taskId", "status"],
      properties: { taskId: uuid, status: { type: "string" } },
    },
    SystemTask: {
      type: "object",
      required: ["id", "kind", "status"],
      properties: {
        id: uuid,
        kind: {
          type: "string",
          enum: ["backup", "garbage-collect", "platform-update"],
        },
        status: {
          type: "string",
          enum: ["queued", "running", "succeeded", "failed"],
        },
        result: { type: "object", nullable: true },
        error: { type: "string", nullable: true },
      },
    },
    Logs: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", maxLength: 262144 },
        stream: { type: "string", enum: ["stdout", "stderr", "both"] },
      },
    },
  };
  for (const [path, methods] of Object.entries(doc.paths))
    for (const [method, op] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      op.operationId ??= `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`;
      const params: unknown[] = [];
      if (path.includes("{id}"))
        params.push({ name: "id", in: "path", required: true, schema: uuid });
      if (path === "/api/v1/projects/{id}/logs")
        params.push(
          {
            name: "service",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "lines",
            in: "query",
            schema: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              default: 100,
            },
          },
          {
            name: "stream",
            in: "query",
            schema: {
              type: "string",
              enum: ["stdout", "stderr", "both"],
              default: "both",
            },
          },
        );
      if (
        ["post", "patch", "put", "delete"].includes(method) &&
        !path.includes("auth/")
      )
        params.push({
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description:
            "Reuse for identical mutations; seven-day retention where supported",
          schema: { type: "string", maxLength: 128 },
        });
      if (params.length) op.parameters = [...(op.parameters ?? []), ...params];
      let schema: unknown;
      if (method === "get" && path === "/api/v1/projects")
        schema = {
          type: "array",
          items: { $ref: "#/components/schemas/Project" },
        };
      else if (method === "get" && path === "/api/v1/projects/{id}")
        schema = { $ref: "#/components/schemas/Project" };
      else if (method === "get" && path === "/api/v1/jobs/{id}")
        schema = { $ref: "#/components/schemas/Job" };
      else if (method === "get" && path === "/api/v1/projects/{id}/logs")
        schema = { $ref: "#/components/schemas/Logs" };
      else if (method === "get" && path === "/api/v1/system/tasks/{id}")
        schema = { $ref: "#/components/schemas/SystemTask" };
      else if (op.responses?.["202"])
        schema = {
          $ref: path.includes("/system/")
            ? "#/components/schemas/TaskReference"
            : "#/components/schemas/JobReference",
        };
      if (schema) {
        const status = op.responses?.["202"] ? "202" : "200";
        op.responses = {
          ...op.responses,
          [status]: {
            description:
              status === "202"
                ? "Accepted; poll the returned job/task"
                : "Success",
            content: { "application/json": { schema } },
          },
        };
      }
    }
  return doc;
}
