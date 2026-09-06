import { publicOpenAPI } from "../apps/api/src/openapi.js";
import { format } from "prettier";
import { writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
const db = new PrismaClient();
const app = await createApp(db);
await app.ready();
await writeFile(
  "docs/openapi.json",
  await format(JSON.stringify(publicOpenAPI(app.swagger())), {
    parser: "json",
  }),
);
await app.close();
await db.$disconnect();
