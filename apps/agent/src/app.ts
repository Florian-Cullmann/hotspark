import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  operationSchema,
  type AgentOperation,
} from "../../../packages/application-spec/src/index.js";
export function createAgent(
  runtime: { execute: (op: AgentOperation) => Promise<unknown> },
  token: string,
) {
  if (token.length < 32)
    throw new Error("Agent token must contain at least 32 characters");
  const app = Fastify({
    bodyLimit: 512 * 1024,
    logger: { redact: ["req.headers.authorization"] },
  });
  const busy = new Set<string>();
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/v1/operations", async (req, reply) => {
    const actual = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid agent credentials" },
      });
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: {
          code: "INVALID_OPERATION",
          message: "Invalid typed operation",
        },
      });
    const read = [
      "inspect",
      "logs",
      "host-info",
      "diagnostics",
      "project-usage",
      "system-task-status",
      "operation-status",
      "deployment-details",
      "cancel-deployment",
    ].includes(parsed.data.operation);
    const project =
      "projectId" in parsed.data
        ? (parsed.data.projectId ?? "system")
        : "system";
    if (!read && busy.has(project))
      return reply.code(409).send({
        error: { code: "AGENT_BUSY", message: "Another operation is active" },
      });
    if (!read) busy.add(project);
    try {
      return await runtime.execute(parsed.data);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      return reply
        .code(status === 409 ? 409 : status === 404 ? 404 : 500)
        .send({
          error: {
            code: "OPERATION_FAILED",
            message: "Operation failed; consult its safe operation status",
          },
        });
    } finally {
      if (!read) busy.delete(project);
    }
  });
  return app;
}
