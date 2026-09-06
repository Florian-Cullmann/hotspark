import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
console.log("fixture secret: " + process.env.API_KEY);
createServer(async (_req, res) => {
  try {
    await db.marker.upsert({
      where: { id: 1 },
      create: { id: 1, value: "persistent" },
      update: {},
    });
    res.end(
      JSON.stringify({
        ready: true,
        database: !!process.env.DATABASE_URL,
        marker: await db.marker.findUnique({ where: { id: 1 } }),
        greeting: process.env.GREETING,
      }),
    );
  } catch {
    res.statusCode = 500;
    res.end("database not ready");
  }
}).listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
