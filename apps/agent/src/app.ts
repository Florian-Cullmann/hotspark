import Fastify from "fastify";
import { operationSchema } from "../../../packages/application-spec/src/index.js";
import type { AgentOperation } from "../../../packages/application-spec/src/index.js";
export function createAgent(runtime: {
  execute: (op: AgentOperation) => Promise<unknown>;
}) {
  const app = Fastify({ bodyLimit: 128 * 1024, logger: true });
  let busy = false;
  app.get("/health", async () => ({ status: "ok" }));
  app.post("/v1/operations", async (req, reply) => {
    const parsed = operationSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: {
          code: "INVALID_OPERATION",
          message: "Invalid typed operation",
        },
      });
    if (busy)
      return reply.code(409).send({
        error: { code: "AGENT_BUSY", message: "Another operation is active" },
      });
    busy = true;
    try {
      return await runtime.execute(parsed.data);
    } catch {
      req.log.error(
        { operation: parsed.data.operation, projectId: parsed.data.projectId },
        "Host operation failed",
      );
      return reply.code(500).send({
        error: { code: "OPERATION_FAILED", message: "Host operation failed" },
      });
    } finally {
      busy = false;
    }
  });
  return app;
}
