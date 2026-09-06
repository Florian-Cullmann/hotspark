import { describe, it, expect } from "vitest";
import {
  applicationSpecSchema,
  operationSchema,
  planDeployment,
} from "../packages/application-spec/src/index.js";
import { renderCompose, renderRoutes } from "../apps/agent/src/runtime.js";
export const id = "8fe0f734-535a-4bad-b87f-7b3c647dc4a3";
export const spec = {
  apiVersion: "hotspark.dev/v1",
  kind: "Application",
  metadata: { name: "example" },
  services: {
    web: {
      type: "nextjs",
      source: { type: "image", image: "example/web@sha256:" + "a".repeat(64) },
      runtime: { port: 3000 },
      domains: ["app.example.com"],
    },
    database: {
      type: "postgres",
      version: "17",
      image: "postgres:17@sha256:" + "b".repeat(64),
    },
  },
};
describe("ApplicationSpec trust boundary", () => {
  it("accepts and normalizes declarative intent", () =>
    expect(applicationSpecSchema.parse(spec).services.web).toHaveProperty(
      "resources.memoryMb",
      512,
    ));
  it.each([
    { ...spec, compose: "services: {}" },
    { ...spec, apiVersion: "v2" },
    { ...spec, metadata: { name: "../../root" } },
    { ...spec, services: { web: { ...spec.services.web, privileged: true } } },
    {
      ...spec,
      services: {
        web: { ...spec.services.web, domains: ["x.com`) || Host(`evil.com"] },
      },
    },
    {
      ...spec,
      services: {
        web: {
          ...spec.services.web,
          source: { type: "image", image: "node:latest" },
        },
      },
    },
  ])("rejects unsafe input", (input) =>
    expect(applicationSpecSchema.safeParse(input).success).toBe(false),
  );
  it("rejects generic shell operations and paths", () => {
    expect(
      operationSchema.safeParse({ operation: "shell", command: "id" }).success,
    ).toBe(false);
    expect(() => planDeployment("../../etc", spec)).toThrow();
  });
  it("keeps databases private and restricts web containers", () => {
    const compose = renderCompose(
      planDeployment(id, spec),
      "/var/lib/hotspark/projects",
    );
    const data = JSON.parse(JSON.stringify(compose));
    expect(data.services.database.networks).toEqual(["private"]);
    expect(data.services.web.networks.proxy.aliases).toEqual([`hs-${id}-web`]);
    expect(data.services.web.cap_drop).toEqual(["ALL"]);
    expect(data.services.web.read_only).toBe(true);
    expect(data.services.web.ports).toBeUndefined();
    expect(data.services.web.volumes).toBeUndefined();
  });
  it("isolates names and compiles deterministic plans", () => {
    expect(planDeployment(id, spec)).toEqual(planDeployment(id, spec));
    expect(planDeployment(id, spec).composeProject).not.toBe(
      planDeployment("759a8e03-1b9f-40b9-a42b-b806846fc9e9", spec)
        .composeProject,
    );
  });
  it("generates health-aware TLS routes without a Docker provider", () => {
    const routes = JSON.stringify(renderRoutes(planDeployment(id, spec), true));
    expect(routes).toContain("letsencrypt");
    expect(routes).toContain("healthCheck");
    expect(routes).not.toContain("database");
  });
});
