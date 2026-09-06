import {
  createProject,
  updateProject,
  idempotent,
  publicProject,
  domainRecords,
  reserveDomains,
  publicJob,
  publicDeployment,
  enqueue,
  projectLock,
  audit,
  fail as projectFail,
} from "./projects.js";
import type { AgentClient } from "./worker.js";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "../../../packages/database/src/index.js";
import {
  applicationSpecSchema,
  createProjectSchema,
  patchProjectSchema,
  nameSchema,
  domainSchema,
  projectIdSchema,
} from "../../../packages/application-spec/src/index.js";
import {
  newToken,
  tokenDigest,
  verifyPassword,
  scopes,
  type Scope,
  hasScope,
} from "../../../packages/shared/src/index.js";
const loginSchema = z
  .object({
    email: z.union([z.email(), z.literal("admin@localhost")]),
    password: z.string().min(1).max(1024),
  })
  .strict();
const tokenSchema = z
  .object({
    name: z.string().min(1).max(80),
    scopes: z.array(z.enum(scopes)).min(1),
    expiresInDays: z.number().int().min(1).max(365).default(30),
  })
  .strict();
const errorSchema = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["code", "message", "requestId"],
    },
  },
  required: ["error"],
};
export async function createApp(
  db: PrismaClient,
  options: { secretsKey?: string; agent?: AgentClient } = {},
) {
  const app = Fastify({
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
    logger: {
      redact: [
        "req.headers.authorization",
        "req.body.password",
        "req.body.token",
        "res.headers.set-cookie",
      ],
    },
    bodyLimit: 128 * 1024,
    trustProxy: false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: { title: "Hotspark API", version: "0.3.0" },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
    },
  });
  app.setErrorHandler((error, req, reply) => {
    let status = 500,
      code = "INTERNAL_ERROR",
      message = "The request could not be completed";
    if (error instanceof z.ZodError) {
      status = 400;
      code = "VALIDATION_ERROR";
      message = error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(";");
    } else if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      status = 409;
      code = "CONFLICT";
      message = "Resource already exists";
    } else if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      code =
        status === 401
          ? "UNAUTHORIZED"
          : status === 403
            ? "FORBIDDEN"
            : status === 404
              ? "NOT_FOUND"
              : status === 429
                ? "RATE_LIMITED"
                : status === 409
                  ? "CONFLICT"
                  : "BAD_REQUEST";
      message =
        status === 401
          ? "Invalid or expired credentials"
          : status === 403
            ? "Insufficient scope"
            : status === 404
              ? "Resource not found"
              : error.message;
    }
    // Never log raw database / Docker errors: they can include connection strings or secrets.
    if (status === 500) req.log.error({ requestId: req.id }, "Request failed");
    reply.code(status).send({ error: { code, message, requestId: req.id } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
        requestId: req.id,
      },
    }),
  );
  function fail(statusCode: number): never {
    throw Object.assign(new Error("Request rejected"), { statusCode });
  }
  async function authenticate(authorization: string | undefined, scope: Scope) {
    if (!authorization?.startsWith("Bearer ") || authorization.length > 256)
      fail(401);
    const token = await db.apiToken.findUnique({
      where: { digest: tokenDigest(authorization.slice(7)) },
      include: { user: true },
    });
    if (
      !token ||
      token.revokedAt ||
      token.expiresAt <= new Date() ||
      token.user.role !== "admin"
    )
      fail(401);
    if (!hasScope(token.scopes, scope)) fail(403);
    return token;
  }
  const secured = (scope: Scope, body?: object, successStatus = 200) => ({
    schema: {
      security: [{ bearerAuth: [] }],
      ...(body ? { body } : {}),
      response: {
        [successStatus]: {},
        400: errorSchema,
        401: errorSchema,
        403: errorSchema,
        409: errorSchema,
      } as Record<number, object>,
    },
    preHandler: async (req: { headers: { authorization?: string } }) => {
      await authenticate(req.headers.authorization, scope);
    },
  });
  app.get(
    "/api/v1/health",
    { schema: { description: "Process liveness" } },
    async () => ({ status: "ok" }),
  );
  app.get("/api/v1/ready", async (_req, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      return { status: "ready" };
    } catch {
      return reply.code(503).send({
        error: {
          code: "NOT_READY",
          message: "Database unavailable",
          requestId: _req.id,
        },
      });
    }
  });
  app.get("/api/v1/openapi.json", async () => app.swagger());
  app.post(
    "/api/v1/auth/login",
    {
      schema: {
        body: z.toJSONSchema(loginSchema, { target: "draft-7", io: "input" }),
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const { email, password } = loginSchema.parse(req.body);
      const user = await db.user.findUnique({ where: { email } });
      // Run the same KDF when the account does not exist to reduce account enumeration.
      const dummy =
        "scrypt$00000000000000000000000000000000$" + "00".repeat(64);
      const valid = await verifyPassword(password, user?.passwordHash ?? dummy);
      if (!user || !valid) fail(401);
      const token = newToken();
      const expiresAt = new Date(Date.now() + 8 * 3600_000);
      await db.$transaction(async (tx) => {
        await tx.apiToken.create({
          data: {
            name: "local session",
            digest: tokenDigest(token),
            scopes: ["admin"],
            userId: user.id,
            expiresAt,
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: user.id,
            action: "auth.login",
            resourceId: user.id,
            requestId: req.id,
          },
        });
      });
      return reply
        .header("Cache-Control", "no-store")
        .send({ token, expiresAt });
    },
  );
  const secretsKey = options.secretsKey;
  const key = () => {
    if (!secretsKey) throw new Error("Encryption key not configured");
    return secretsKey;
  };
  const agent = async (op: Parameters<AgentClient>[0]) => {
    if (!options.agent) throw new Error("Agent not configured");
    return options.agent(op);
  };
  const idOf = (params: unknown) =>
    projectIdSchema.parse((params as { id: string }).id);
  const getProject = async (id: string) => {
    const project = await db.project.findUnique({ where: { id } });
    if (!project || project.deletedAt) projectFail(404);
    return project;
  };
  const mutate = async (
    req: {
      headers: {
        authorization?: string;
        "idempotency-key"?: string | string[];
      };
      id: string;
    },
    scope: Scope,
    input: unknown,
    work: (
      tx: Prisma.TransactionClient,
      actorId: string,
      tokenId: string,
    ) => Promise<unknown>,
  ) => {
    const actor = await authenticate(req.headers.authorization, scope);
    const raw = req.headers["idempotency-key"];
    if (Array.isArray(raw)) projectFail(400);
    return idempotent(
      db,
      actor.userId,
      raw,
      input,
      async (tx) => {
        const result = await work(tx, actor.userId, actor.id);
        if (
          result &&
          typeof result === "object" &&
          "jobId" in result &&
          typeof result.jobId === "string"
        )
          await tx.deployment.updateMany({
            where: { jobs: { some: { id: result.jobId } } },
            data: { tokenId: actor.id },
          });
        return result;
      },
      key(),
    );
  };
  app.get("/api/v1/projects", secured("projects:read"), async () =>
    (
      await db.project.findMany({
        where: { deletedAt: null },
        take: 100,
        orderBy: { createdAt: "desc" },
      })
    ).map(publicProject),
  );
  app.post(
    "/api/v1/projects",
    secured(
      "projects:create",
      z.toJSONSchema(createProjectSchema, { target: "draft-7", io: "input" }),
      202,
    ),
    async (req, reply) => {
      const input = createProjectSchema.parse(req.body);
      if (
        Object.values(input.spec.services).some(
          (s) => s.type !== "postgres" && s.domains.length,
        )
      )
        await authenticate(req.headers.authorization, "domains:manage");
      const response = await mutate(
        req,
        "projects:create",
        { method: "create", ...input },
        (tx, actor) =>
          createProject(tx, input.spec, input.secrets, key(), actor, req.id),
      );
      return reply.code(202).send(response);
    },
  );
  app.get("/api/v1/projects/:id", secured("projects:read"), async (req) =>
    publicProject(await getProject(idOf(req.params))),
  );
  app.patch(
    "/api/v1/projects/:id",
    secured(
      "projects:update",
      z.toJSONSchema(patchProjectSchema, { target: "draft-7", io: "input" }),
      202,
    ),
    async (req, reply) => {
      const id = idOf(req.params),
        input = patchProjectSchema.parse(req.body);
      const actorToken = await authenticate(
        req.headers.authorization,
        "projects:update",
      );
      return reply
        .code(202)
        .send(
          await mutate(
            req,
            "projects:update",
            { method: "patch", id, ...input },
            (tx, actor) =>
              updateProject(
                tx,
                id,
                input.spec,
                input.secrets,
                key(),
                actor,
                req.id,
                input.restoreOnDrift,
                hasScope(actorToken.scopes, "domains:manage"),
              ),
          ),
        );
    },
  );
  const lifecycle = async (
    req: {
      params: unknown;
      headers: {
        authorization?: string;
        "idempotency-key"?: string | string[];
      };
      id: string;
    },
    operation: string,
    scope: Scope,
  ) => {
    const id = idOf(req.params);
    return mutate(
      req,
      scope,
      { method: operation, id },
      async (tx, actor, tokenId) => {
        await projectLock(tx, id);
        const project = await tx.project.findUnique({ where: { id } });
        if (!project || project.deletedAt) projectFail(404);
        return enqueue(tx, id, operation, actor, req.id, { tokenId });
      },
    );
  };
  for (const operation of ["start", "stop", "restart", "deploy"] as const)
    app.post(
      `/api/v1/projects/:id/${operation}`,
      secured("projects:update", undefined, 202),
      async (req, reply) =>
        reply
          .code(202)
          .send(await lifecycle(req, operation, "projects:update")),
    );
  app.post(
    "/api/v1/projects/:id/deployments",
    secured("projects:update", undefined, 202),
    async (req, reply) =>
      reply.code(202).send(await lifecycle(req, "deploy", "projects:update")),
  );
  const rollbackInput = z.object({ deploymentId: z.string().uuid() }).strict();
  app.post(
    "/api/v1/projects/:id/rollbacks",
    secured(
      "projects:update",
      z.toJSONSchema(rollbackInput, { target: "draft-7", io: "input" }),
      202,
    ),
    async (req, reply) => {
      const id = idOf(req.params),
        input = rollbackInput.parse(req.body);
      return reply.code(202).send(
        await mutate(
          req,
          "projects:update",
          { method: "rollback", id, ...input },
          async (tx, actor, tokenId) => {
            await projectLock(tx, id);
            const p = await tx.project.findUnique({ where: { id } });
            if (!p || p.deletedAt) projectFail(404);
            const target = await tx.deployment.findUnique({
              where: { id: input.deploymentId },
            });
            if (!target || target.projectId !== id) projectFail(404);
            const current = applicationSpecSchema.parse(p.spec),
              old = applicationSpecSchema.parse(
                target.resolvedSpec ?? target.spec,
              );
            if (
              JSON.stringify(domainRecords(current)) !==
              JSON.stringify(domainRecords(old))
            )
              await authenticate(req.headers.authorization, "domains:manage");
            await reserveDomains(tx, id, old);
            return enqueue(tx, id, "deploy", actor, req.id, {
              rollbackOf: input.deploymentId,
              tokenId,
            });
          },
        ),
      );
    },
  );
  const maintenanceInput = z.object({ enabled: z.boolean() }).strict();
  app.put(
    "/api/v1/projects/:id/maintenance",
    secured(
      "projects:update",
      z.toJSONSchema(maintenanceInput, { target: "draft-7", io: "input" }),
      202,
    ),
    async (req, reply) => {
      const id = idOf(req.params),
        input = maintenanceInput.parse(req.body);
      return reply.code(202).send(
        await mutate(
          req,
          "projects:update",
          { method: "maintenance", id, ...input },
          async (tx, actor, tokenId) => {
            await projectLock(tx, id);
            const p = await tx.project.findUnique({ where: { id } });
            if (!p || p.deletedAt) projectFail(404);
            return enqueue(tx, id, "maintenance", actor, req.id, {
              maintenanceEnabled: input.enabled,
              tokenId,
            });
          },
        ),
      );
    },
  );
  app.get("/api/v1/deployments/:id", secured("projects:read"), async (req) => {
    const release = await db.deployment.findUnique({
      where: { id: idOf(req.params) },
    });
    if (!release) projectFail(404);
    await getProject(release.projectId);
    const runtime = await agent({
      operation: "deployment-details",
      projectId: release.projectId,
      deploymentId: release.id,
    }).catch(() => null);
    if (runtime && typeof runtime === "object" && "logs" in runtime)
      delete runtime.logs;
    return { ...publicDeployment(release), runtime };
  });
  app.get("/api/v1/deployments/:id/logs", secured("logs:read"), async (req) => {
    const release = await db.deployment.findUnique({
      where: { id: idOf(req.params) },
    });
    if (!release) projectFail(404);
    await getProject(release.projectId);
    return agent({
      operation: "deployment-details",
      projectId: release.projectId,
      deploymentId: release.id,
    });
  });
  app.post(
    "/api/v1/deployments/:id/cancel",
    secured("projects:update"),
    async (req) => {
      const release = await db.deployment.findUnique({
        where: { id: idOf(req.params) },
      });
      if (!release) projectFail(404);
      await getProject(release.projectId);
      const result = await agent({
        operation: "cancel-deployment",
        projectId: release.projectId,
        deploymentId: release.id,
      });
      const actor = await authenticate(
        req.headers.authorization,
        "projects:update",
      );
      await db.auditEvent.create({
        data: {
          actorId: actor.userId,
          action: "deployment.cancel.requested",
          resourceId: release.id,
          requestId: req.id,
        },
      });
      return result;
    },
  );
  app.delete(
    "/api/v1/projects/:id",
    secured("projects:delete", undefined, 202),
    async (req, reply) =>
      reply.code(202).send(await lifecycle(req, "remove", "projects:delete")),
  );
  for (const resource of [
    "services",
    "domains",
    "jobs",
    "deployments",
  ] as const)
    app.get(
      `/api/v1/projects/:id/${resource}`,
      secured("projects:read"),
      async (req) => {
        const projectId = idOf(req.params);
        await getProject(projectId);
        switch (resource) {
          case "services":
            return db.service.findMany({ where: { projectId } });
          case "domains":
            return db.domain.findMany({ where: { projectId } });
          case "jobs":
            return (
              await db.job.findMany({
                where: { projectId },
                take: 100,
                orderBy: { createdAt: "desc" },
              })
            ).map(publicJob);
          case "deployments":
            return (
              await db.deployment.findMany({
                where: { projectId },
                take: 100,
                orderBy: { createdAt: "desc" },
              })
            ).map(publicDeployment);
        }
      },
    );
  const domainInput = z
    .object({ service: nameSchema, domains: z.array(domainSchema).max(10) })
    .strict();
  app.put(
    "/api/v1/projects/:id/domains",
    secured(
      "domains:manage",
      z.toJSONSchema(domainInput, { target: "draft-7", io: "input" }),
      202,
    ),
    async (req, reply) => {
      const id = idOf(req.params),
        input = domainInput.parse(req.body);
      await authenticate(req.headers.authorization, "projects:update");
      return reply.code(202).send(
        await mutate(
          req,
          "domains:manage",
          { method: "domains", id, ...input },
          async (tx, actor) => {
            await projectLock(tx, id);
            const p = await tx.project.findUnique({ where: { id } });
            if (!p || p.deletedAt) projectFail(404);
            const spec = applicationSpecSchema.parse(p.spec);
            const service = spec.services[input.service];
            if (!service || service.type === "postgres")
              projectFail(400, "Domains require an HTTP service");
            service.domains = input.domains;
            return updateProject(tx, id, spec, {}, key(), actor, req.id);
          },
        ),
      );
    },
  );
  app.get("/api/v1/projects/:id/logs", secured("logs:read"), async (req) => {
    const id = idOf(req.params);
    await getProject(id);
    const query = z
      .object({
        service: nameSchema,
        lines: z.coerce.number().int().min(1).max(1000).default(100),
        stream: z.enum(["stdout", "stderr", "both"]).default("both"),
      })
      .strict()
      .parse(req.query);
    return agent({ operation: "logs", projectId: id, ...query });
  });
  app.get(
    "/api/v1/projects/:id/runtime",
    secured("projects:read"),
    async (req) => {
      const id = idOf(req.params);
      await getProject(id);
      return agent({ operation: "inspect", projectId: id });
    },
  );
  app.get("/api/v1/jobs/:id", secured("projects:read"), async (req) => {
    const job = await db.job.findUnique({
      where: { id: idOf(req.params) },
      include: { events: { take: 100, orderBy: { createdAt: "desc" } } },
    });
    if (!job) projectFail(404);
    return publicJob(job);
  });
  app.post(
    "/api/v1/jobs/:id/cancel",
    secured("projects:update"),
    async (req, reply) => {
      const id = idOf(req.params);
      const actor = await authenticate(
        req.headers.authorization,
        "projects:update",
      );
      await db.$transaction(async (tx) => {
        const job = await tx.job.findUnique({ where: { id } });
        if (!job) projectFail(404);
        if (job.operation === "remove")
          await authenticate(req.headers.authorization, "projects:delete");
        await projectLock(tx, job.projectId);
        const result = await tx.job.updateMany({
          where: { id, status: "queued", attempts: 0 },
          data: {
            status: "cancelled",
            finishedAt: new Date(),
            error: "Cancelled before execution",
          },
        });
        if (!result.count)
          projectFail(409, "Only queued jobs can be cancelled");
        const payload = job.payload as {
          previousDesiredState?: string;
          previousObservedState?: string;
          previousMaintenance?: boolean;
        } | null;
        await tx.project.update({
          where: { id: job.projectId },
          data: {
            desiredState: payload?.previousDesiredState ?? "stopped",
            observedState: payload?.previousObservedState ?? "created",
            ...(job.operation === "maintenance"
              ? { maintenanceEnabled: payload?.previousMaintenance ?? false }
              : {}),
          },
        });
        if (job.deploymentId)
          await tx.deployment.update({
            where: { id: job.deploymentId },
            data: { status: "cancelled" },
          });
        await tx.jobEvent.create({
          data: { jobId: id, message: "cancelled", progress: job.progress },
        });
        await audit(tx, actor.userId, "job.cancel", id, req.id);
      });
      return reply.send({ status: "cancelled" });
    },
  );
  app.post(
    "/api/v1/jobs/:id/retry",
    secured("projects:update", undefined, 202),
    async (req, reply) => {
      const id = idOf(req.params);
      return reply.code(202).send(
        await mutate(
          req,
          "projects:update",
          { method: "retry", id },
          async (tx, actor) => {
            const job = await tx.job.findUnique({
              where: { id },
              include: { deployment: true },
            });
            if (!job) projectFail(404);
            if (job.status !== "failed")
              projectFail(409, "Only failed jobs can be retried");
            if (
              job.deployment &&
              Object.values(
                applicationSpecSchema.parse(job.deployment.spec).services,
              ).some((s) => s.type !== "postgres" && s.hooks.length)
            )
              projectFail(
                409,
                "Migration jobs need explicit operator review and a new deployment",
              );
            if (job.operation === "remove")
              await authenticate(req.headers.authorization, "projects:delete");
            await projectLock(tx, job.projectId);
            return enqueue(tx, job.projectId, job.operation, actor, req.id);
          },
        ),
      );
    },
  );
  app.get("/api/v1/dashboard", secured("projects:read"), async () => {
    const groups = await db.project.groupBy({
      by: ["observedState"],
      where: { deletedAt: null },
      _count: true,
    });
    let host: unknown = null;
    try {
      host = await agent({ operation: "host-info" });
    } catch {
      /* health remains useful when agent is offline */
    }
    return {
      health: host ? "ready" : "agent-unavailable",
      counts: Object.fromEntries(
        groups.map((g) => [g.observedState, g._count]),
      ),
      host,
    };
  });
  app.get("/api/v1/tokens", secured("admin"), async () =>
    db.apiToken.findMany({
      select: {
        id: true,
        name: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
  );
  app.post(
    "/api/v1/tokens",
    secured(
      "admin",
      z.toJSONSchema(tokenSchema, { target: "draft-7", io: "input" }),
      201,
    ),
    async (req, reply) => {
      const input = tokenSchema.parse(req.body);
      const actor = await authenticate(req.headers.authorization, "admin");
      const token = newToken();
      const record = await db.$transaction(async (tx) => {
        const record = await tx.apiToken.create({
          data: {
            name: input.name,
            scopes: input.scopes,
            digest: tokenDigest(token),
            userId: actor.userId,
            expiresAt: new Date(Date.now() + input.expiresInDays * 86400_000),
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.userId,
            action: "token.create",
            resourceId: record.id,
            requestId: req.id,
          },
        });
        return record;
      });
      return reply
        .code(201)
        .header("Cache-Control", "no-store")
        .send({ id: record.id, token, expiresAt: record.expiresAt });
    },
  );
  app.delete(
    "/api/v1/tokens/:id",
    secured("admin", undefined, 204),
    async (req, reply) => {
      const id = projectIdSchema.parse((req.params as { id: string }).id);
      const actor = await authenticate(req.headers.authorization, "admin");
      await db.$transaction(async (tx) => {
        const result = await tx.apiToken.updateMany({
          where: { id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (!result.count) fail(404);
        await tx.auditEvent.create({
          data: {
            actorId: actor.userId,
            action: "token.revoke",
            resourceId: id,
            requestId: req.id,
          },
        });
      });
      return reply.code(204).send();
    },
  );
  app.get("/api/v1/audit-events", secured("admin"), async () =>
    db.auditEvent.findMany({ take: 100, orderBy: { createdAt: "desc" } }),
  );
  return app;
}
