import { request } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { createHmac } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { secret } from "../../../packages/shared/src/index.js";
export interface Notification {
  id: string;
  type: string;
  resourceId: string;
  createdAt: Date;
}
export interface NotificationAdapter {
  send(event: Notification): Promise<void>;
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["192.0.0.0", 24],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix);
export function publicAddress(address: string) {
  // v1 deliberately permits only ordinary public IPv4; IPv6/mapped addresses are refused.
  return isIP(address) === 4 && !blocked.check(address);
}
export function webhookAdapter(
  origin: string,
  key: string,
): NotificationAdapter {
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    isIP(url.hostname) ||
    key.length < 32
  )
    throw new Error("Invalid webhook configuration");
  return {
    async send(event) {
      const addresses = await lookup(url.hostname, { all: true, family: 4 });
      if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
        throw new Error("Webhook destination rejected");
      const data = JSON.stringify({ version: 1, ...event }),
        timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", key)
        .update(`${timestamp}.${data}`)
        .digest("hex");
      await new Promise<void>((resolve, reject) => {
        const req = request(
          url,
          {
            method: "POST",
            family: 4,
            agent: false,
            timeout: 10000,
            lookup: (_host, _options, callback) =>
              callback(null, addresses[0]!.address, 4),
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(data),
              "x-hotspark-timestamp": timestamp,
              "x-hotspark-signature": `sha256=${signature}`,
              "x-hotspark-event-id": event.id,
            },
          },
          (res) => {
            res.destroy(); // No redirects or unbounded response body; socket is pinned to vetted DNS.
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
              resolve();
            else reject(new Error("Webhook delivery failed"));
          },
        );
        req.on("error", () => reject(new Error("Webhook delivery failed")));
        req.on("timeout", () => req.destroy(new Error("Webhook timeout")));
        req.end(data);
      });
    },
  };
}
export async function deliverNotifications(
  db: PrismaClient,
  adapter?: NotificationAdapter,
) {
  if (!adapter) return;
  const events = await db.platformEvent.findMany({
    where: { deliveredAt: null, attempts: { lt: 5 } },
    take: 10,
    orderBy: { createdAt: "asc" },
  });
  for (const event of events) {
    await db.platformEvent.update({
      where: { id: event.id },
      data: { attempts: { increment: 1 } },
    });
    try {
      await adapter.send({
        id: event.id,
        type: event.type,
        resourceId: event.resourceId,
        createdAt: event.createdAt,
      });
      await db.platformEvent.update({
        where: { id: event.id },
        data: { deliveredAt: new Date() },
      });
    } catch {
      /* Bounded retries. Payloads contain identifiers and enums only; never log destination or response. */
    }
  }
}
export async function configuredNotifications() {
  return process.env.NOTIFICATION_WEBHOOK_URL
    ? webhookAdapter(
        process.env.NOTIFICATION_WEBHOOK_URL,
        await secret("NOTIFICATION_WEBHOOK_KEY"),
      )
    : undefined;
}
