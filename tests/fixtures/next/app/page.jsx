import { PrismaClient } from "@prisma/client";
export const dynamic = "force-dynamic";
const db = new PrismaClient();
export default async function Page() {
  await db.marker.upsert({
    where: { id: 1 },
    create: { id: 1, value: "next-persistent" },
    update: {},
  });
  return (
    <main>
      hotspark-next-ready:{" "}
      {(await db.marker.findUnique({ where: { id: 1 } })).value}
    </main>
  );
}
