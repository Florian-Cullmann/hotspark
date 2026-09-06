import { createApp } from "./app.js";
import { connectDatabase } from "../../../packages/database/src/index.js";
import { hashPassword, secret } from "../../../packages/shared/src/index.js";
import { runOneJob } from "./worker.js";
const db = await connectDatabase();
const email = process.env.ADMIN_EMAIL ?? "admin@localhost";
if (!(await db.user.findUnique({ where: { email } }))) {
  const password = await secret("ADMIN_PASSWORD");
  await db.user.create({
    data: { email, passwordHash: await hashPassword(password) },
  });
}
// v1 runs one API replica. Interrupted jobs require explicit operator reconciliation.
await db.$transaction(async (tx) => {
  await tx.job.updateMany({
    where: { status: "running" },
    data: {
      status: "failed",
      error: "Control plane restarted; reconcile runtime before retry",
      finishedAt: new Date(),
    },
  });
  await tx.deployment.updateMany({
    where: { status: "queued", jobs: { some: { status: "failed" } } },
    data: { status: "failed" },
  });
});
const app = await createApp(db);
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
});
let stopping = false;
const worker = (async () => {
  while (!stopping) {
    try {
      await runOneJob(
        db,
        process.env.AGENT_SOCKET ?? "/run/hotspark/agent.sock",
      );
    } catch {
      app.log.error("Job worker failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
})();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    void (async () => {
      await app.close();
      await worker;
      await db.$disconnect();
    })();
  });
