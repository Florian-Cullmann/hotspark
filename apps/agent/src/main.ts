import { mkdir, chmod, chown, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createAgent } from "./app.js";
import { Runtime } from "./runtime.js";
const socket = process.env.AGENT_SOCKET ?? "/run/hotspark/agent.sock";
await mkdir(dirname(socket), { recursive: true, mode: 0o750 });
try {
  const stat = await lstat(socket);
  if (!stat.isSocket())
    throw new Error("Refusing to replace a non-socket path");
  await unlink(socket);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const app = createAgent(
  new Runtime(
    process.env.STATE_ROOT ?? "/var/lib/hotspark/projects",
    process.env.ROUTES_ROOT ?? "/var/lib/hotspark/routes",
    undefined,
    process.env.TLS_ENABLED === "true",
  ),
);
await app.listen({ path: socket });
await chown(socket, 0, 10001);
await chmod(socket, 0o660);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void app.close();
  });
