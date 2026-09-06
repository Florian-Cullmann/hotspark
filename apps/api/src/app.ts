import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "../../../packages/database/src/index.js";
import {
  applicationSpecSchema,
  applicationSpecJsonSchema,
  projectIdSchema,
} from "../../../packages/application-spec/src/index.js";
import {
  newToken,
  tokenDigest,
  verifyPassword,
  scopes,
  type Scope,
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
export async function createApp(db: PrismaClient) {
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
      info: { title: "Hotspark API", version: "0.1.0" },
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
                : "BAD_REQUEST";
      message =
        status === 401
          ? "Invalid or expired credentials"
          : status === 403
            ? "Insufficient scope"
            : status === 404
              ? "Resource not found"
              : "Request rejected";
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
    if (!token.scopes.includes(scope) && !token.scopes.includes("admin"))
      fail(403);
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
  app.get("/api/v1/projects", secured("read"), async () =>
    db.project.findMany({ orderBy: { createdAt: "desc" } }),
  );
  app.post(
    "/api/v1/projects",
    secured("deploy", applicationSpecJsonSchema, 201),
    async (req, reply) => {
      const spec = applicationSpecSchema.parse(req.body);
      const actor = await authenticate(req.headers.authorization, "deploy");
      const project = await db.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            name: spec.metadata.name,
            spec: spec as Prisma.InputJsonValue,
            services: {
              create: Object.entries(spec.services).map(([name, s]) => ({
                name,
                type: s.type,
              })),
            },
            domains: {
              create: Object.entries(spec.services).flatMap(
                ([serviceName, s]) =>
                  "domains" in s
                    ? s.domains.map((hostname) => ({ hostname, serviceName }))
                    : [],
              ),
            },
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.userId,
            action: "project.create",
            resourceId: project.id,
            requestId: req.id,
          },
        });
        return project;
      });
      return reply.code(201).send(project);
    },
  );
  app.get("/api/v1/projects/:id", secured("read"), async (req) => {
    const { id } = req.params as { id: string };
    const project = await db.project.findUnique({
      where: { id: projectIdSchema.parse(id) },
    });
    if (!project) fail(404);
    return project;
  });
  for (const resource of [
    "services",
    "domains",
    "deployments",
    "jobs",
  ] as const) {
    app.get(
      `/api/v1/projects/:id/${resource}`,
      secured("read"),
      async (req) => {
        const projectId = projectIdSchema.parse(
          (req.params as { id: string }).id,
        );
        if (!(await db.project.findUnique({ where: { id: projectId } })))
          fail(404);
        switch (resource) {
          case "services":
            return db.service.findMany({ where: { projectId } });
          case "domains":
            return db.domain.findMany({ where: { projectId } });
          case "deployments":
            return db.deployment.findMany({
              where: { projectId },
              take: 100,
              orderBy: { createdAt: "desc" },
            });
          case "jobs":
            return db.job.findMany({
              where: { projectId },
              take: 100,
              orderBy: { createdAt: "desc" },
            });
        }
      },
    );
  }
  for (const operation of ["deploy", "start", "stop"] as const) {
    app.post(
      `/api/v1/projects/:id/${operation}`,
      secured("deploy", undefined, 202),
      async (req, reply) => {
        const projectId = projectIdSchema.parse(
          (req.params as { id: string }).id,
        );
        const actor = await authenticate(req.headers.authorization, "deploy");
        const job = await db.$transaction(async (tx) => {
          // Serialize scheduling per project across concurrent requests.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`;
          const project = await tx.project.findUnique({
            where: { id: projectId },
          });
          if (!project) fail(404);
          if (
            await tx.job.findFirst({
              where: { projectId, status: { in: ["queued", "running"] } },
            })
          )
            fail(409);
          const deployment =
            operation === "deploy"
              ? await tx.deployment.create({
                  data: {
                    projectId,
                    spec: project.spec as Prisma.InputJsonValue,
                  },
                })
              : null;
          const job = await tx.job.create({
            data: { projectId, operation, deploymentId: deployment?.id },
          });
          await tx.auditEvent.create({
            data: {
              actorId: actor.userId,
              action: `project.${operation}`,
              resourceId: projectId,
              requestId: req.id,
            },
          });
          return job;
        });
        return reply.code(202).send(job);
      },
    );
  }
  app.get("/api/v1/jobs/:id", secured("read"), async (req) => {
    const job = await db.job.findUnique({
      where: { id: projectIdSchema.parse((req.params as { id: string }).id) },
    });
    if (!job) fail(404);
    return job;
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
