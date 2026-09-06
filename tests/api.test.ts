import { it, expect, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
import { createAgent } from "../apps/agent/src/app.js";
it("serves liveness and OpenAPI without a database, protects resources", async () => {
  const db = new PrismaClient();
  const app = await createApp(db);
  expect((await app.inject("/api/v1/health")).json()).toEqual({ status: "ok" });
  const denied = await app.inject("/api/v1/projects");
  expect(denied.statusCode).toBe(401);
  expect(denied.json().error.code).toBe("UNAUTHORIZED");
  const schema = (await app.inject("/api/v1/openapi.json")).json();
  expect(schema.paths["/api/v1/projects"].post.requestBody).toBeDefined();
  expect((await app.inject("/absent")).json().error.code).toBe("NOT_FOUND");
  await app.close();
  await db.$disconnect();
});
it("rejects shell/Compose input before runtime and bounds concurrent work", async () => {
  let finish: (value: unknown) => void = () => {};
  const execute = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const app = createAgent({ execute });
  const denied = await app.inject({
    method: "POST",
    url: "/v1/operations",
    payload: { operation: "shell", command: "id" },
  });
  expect(denied.statusCode).toBe(400);
  expect(execute).not.toHaveBeenCalled();
  const payload = {
    operation: "inspect",
    projectId: "8fe0f734-535a-4bad-b87f-7b3c647dc4a3",
  };
  const first = app.inject({ method: "POST", url: "/v1/operations", payload });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect(
    (await app.inject({ method: "POST", url: "/v1/operations", payload }))
      .statusCode,
  ).toBe(409);
  finish({ services: [] });
  expect((await first).statusCode).toBe(200);
  await app.close();
});
