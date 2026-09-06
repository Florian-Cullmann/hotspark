import { describe, it, expect } from "vitest";
import {
  applicationSpecSchema,
  operationSchema,
} from "../packages/application-spec/src/index.js";
import {
  planDeployment,
  resourceName,
} from "../packages/providers/src/index.js";
import { renderCompose, renderRoutes } from "../apps/agent/src/runtime.js";
const id = "8fe0f734-535a-4bad-b87f-7b3c647dc4a3";
export const spec = {
  apiVersion: "hotspark.dev/v1",
  kind: "Application",
  metadata: { name: "example" },
  services: {
    web: {
      type: "nextjs",
      source: {
        type: "git",
        repository: "https://github.com/example/app.git",
        commit: "a".repeat(40),
      },
      runtime: { port: 3000 },
      domains: ["APP.EXAMPLE.COM"],
      database: "database",
      secrets: ["API_KEY"],
      hooks: [{ type: "prisma-migrate-deploy" }],
    },
    database: { type: "postgres", version: "17" },
  },
};
describe("Intent, providers and resource boundaries", () => {
  it("normalizes hostnames and produces a deterministic versioned plan", () => {
    const plan = planDeployment(id, spec);
    expect(plan.version).toBe(2);
    expect(plan.spec.services.web).toHaveProperty("domains", [
      "app.example.com",
    ]);
    expect(plan).toEqual(
      planDeployment(id, {
        ...spec,
        services: { database: spec.services.database, web: spec.services.web },
      }),
    );
  });
  it.each([
    { ...spec, compose: "arbitrary" },
    { ...spec, metadata: { name: "../escape" } },
    { ...spec, services: { web: { ...spec.services.web, privileged: true } } },
    {
      ...spec,
      services: {
        ...spec.services,
        web: { ...spec.services.web, database: "missing" },
      },
    },
    {
      ...spec,
      services: {
        ...spec.services,
        web: {
          ...spec.services.web,
          environment: { NODE_OPTIONS: "--require evil" },
        },
      },
    },
    {
      ...spec,
      services: {
        ...spec.services,
        web: {
          ...spec.services.web,
          build: { startCommand: ["npm", "run", "dev"] },
        },
      },
    },
    {
      ...spec,
      services: {
        ...spec.services,
        web: {
          ...spec.services.web,
          hooks: [{ type: "shell", command: "id" }],
        },
      },
    },
  ])("rejects unsafe input", (input) =>
    expect(applicationSpecSchema.safeParse(input).success).toBe(false),
  );
  it("generates internal names, isolated networks and secret references", () => {
    const plan = planDeployment(id, spec);
    const compose = JSON.parse(
      JSON.stringify(renderCompose(plan, "/run/hotspark-secrets")),
    );
    const db = plan.services.find((s) => s.type === "postgres")!,
      web = plan.services.find((s) => s.type === "nextjs")!;
    expect(db.id).toMatch(/^s-[a-f0-9]{16}$/);
    expect(db.id).not.toBe(
      resourceName("759a8e03-1b9f-40b9-a42b-b806846fc9e9", "database"),
    );
    expect(compose.services[db.id].networks).toEqual(["private"]);
    expect(compose.services[db.id].ports).toBeUndefined();
    expect(compose.services[web.id].networks.proxy.aliases).toEqual([
      web.alias,
    ]);
    expect(compose.services[web.id].environment.DATABASE_URL).toBeUndefined();
    expect(compose.services[web.id].environment.HOTSPARK_ENV_FILE).toContain(
      "/run/secrets/",
    );
    expect(compose.services[web.id].cap_drop).toEqual(["ALL"]);
    expect(compose.services[web.id].volumes).toBeUndefined();
    expect(JSON.stringify(renderRoutes(plan, true))).toContain("letsencrypt");
  });
  it("uses generated Node and static templates instead of a repository Dockerfile", () => {
    const plan = planDeployment(id, spec);
    expect(plan.builds[0]!.dockerfile).toContain("COPY --from=source");
    expect(plan.builds[0]!.files["build.json"]).toContain(
      '"install":["npm","ci"]',
    );
    const react = planDeployment(id, {
      ...spec,
      services: { web: { type: "react", source: spec.services.web.source } },
    });
    expect(react.builds[0]!.dockerfile).toContain("nginx-unprivileged");
    expect(react.services[0]!.port).toBe(8080);
  });
  it("supports pnpm/yarn, explicit argv and standalone assets", () => {
    for (const pm of ["pnpm", "yarn"]) {
      const p = planDeployment(id, {
        ...spec,
        services: {
          web: {
            ...spec.services.web,
            database: undefined,
            hooks: [],
            secrets: [],
            build: { packageManager: pm, standalone: true },
          },
        },
      });
      expect(p.builds[0]!.dockerfile).toContain(pm);
      expect(p.builds[0]!.dockerfile).toContain(
        ".next/standalone/.next/static",
      );
    }
  });
  it("rejects shell operations and requires mutation identities", () => {
    expect(
      operationSchema.safeParse({ operation: "shell", command: "id" }).success,
    ).toBe(false);
    expect(
      operationSchema.safeParse({ operation: "stop", projectId: id }).success,
    ).toBe(false);
  });
});
