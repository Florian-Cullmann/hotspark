import { it, expect, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
import { createAgent } from "../apps/agent/src/app.js";
const token = "a".repeat(64),
  headers = { authorization: `Bearer ${token}` };
it("serves liveness/OpenAPI and protects resources", async () => {
  const db = new PrismaClient();
  const app = await createApp(db);
  expect((await app.inject("/api/v1/health")).json()).toEqual({ status: "ok" });
  expect((await app.inject("/api/v1/projects")).statusCode).toBe(401);
  const schema = (await app.inject("/api/v1/openapi.json")).json();
  expect(schema.paths["/api/v1/projects"].post.responses["202"]).toBeDefined();
  expect(schema.paths["/api/v1/projects/{id}"].patch).toBeDefined();
  await app.close();
  await db.$disconnect();
});
it("authenticates agent requests before dispatch, rejects shells and bounds mutations", async () => {
  let finish: (value: unknown) => void = () => {};
  const execute = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const app = createAgent({ execute }, token);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/operations",
        payload: { operation: "host-info" },
      })
    ).statusCode,
  ).toBe(401);
  expect(execute).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers,
        payload: { operation: "shell", command: "id" },
      })
    ).statusCode,
  ).toBe(400);
  const payload = {
    operation: "stop",
    projectId: "8fe0f734-535a-4bad-b87f-7b3c647dc4a3",
    operationId: "759a8e03-1b9f-40b9-a42b-b806846fc9e9",
  };
  const first = app.inject({
    method: "POST",
    url: "/v1/operations",
    headers,
    payload,
  });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/operations",
        headers,
        payload,
      })
    ).statusCode,
  ).toBe(409);
  finish({ state: "stopped" });
  expect((await first).statusCode).toBe(200);
  await app.close();
});
