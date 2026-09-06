import { PrismaClient } from "@prisma/client";
import { secret } from "../../shared/src/index.js";
export { PrismaClient };
export async function connectDatabase() {
  if (!process.env.DATABASE_URL) {
    const password = await secret("DATABASE_PASSWORD");
    process.env.DATABASE_URL = `postgresql://hotspark:${encodeURIComponent(password)}@${process.env.DATABASE_HOST ?? "database"}:5432/hotspark`;
  }
  return new PrismaClient();
}
