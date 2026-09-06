import { createApp } from "./app.js";
import { connectDatabase } from "../../../packages/database/src/index.js";
import { hashPassword, secret } from "../../../packages/shared/src/index.js";
import { runOneJob, reconcile, agentClient } from "./worker.js";
const db = await connectDatabase();
const email = process.env.ADMIN_EMAIL ?? "admin@localhost";
if (!(await db.user.findUnique({ where: { email } }))) {
  const password = await secret("ADMIN_PASSWORD");
  await db.user.create({
    data: { email, passwordHash: await hashPassword(password) },
  });
}
const secretsKey = await secret("SECRETS_KEY");
const client = agentClient(
  process.env.AGENT_SOCKET ?? "/run/hotspark/agent.sock",
  await secret("AGENT_TOKEN"),
);
const app = await createApp(db, { secretsKey, agent: client });
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
});
let stopping = false;
const workers = Array.from({ length: 4 }, () =>
  (async () => {
    while (!stopping) {
      try {
        await runOneJob(db, client);
      } catch {
        app.log.error("Job worker failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })(),
);
const reconciler = (async () => {
  let last = 0;
  while (!stopping) {
    if (Date.now() - last >= 15000) {
      try {
        await reconcile(db, client);
        await db.jobEvent.deleteMany({
          where: {
            createdAt: { lt: new Date(Date.now() - 30 * 86400000) },
            job: { status: { notIn: ["queued", "running"] } },
          },
        });
      } catch {
        app.log.error("Reconciliation failed");
      }
      last = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
})();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    void (async () => {
      await app.close();
      await Promise.all([...workers, reconciler]);
      await db.$disconnect();
    })();
  });
