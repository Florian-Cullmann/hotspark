import { it, expect } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../apps/agent/src/runtime.js";
import { operationSchema } from "../packages/application-spec/src/index.js";
const projectId = "8fe0f734-535a-4bad-b87f-7b3c647dc4a3",
  deploymentId = "759a8e03-1b9f-40b9-a42b-b806846fc9e9";
const operation = operationSchema.parse({
  operation: "deploy",
  projectId,
  deploymentId,
  spec: {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: "build-test" },
    services: {
      web: {
        type: "web",
        source: {
          type: "git",
          repository: "https://github.com/example/app.git",
          commit: "a".repeat(40),
        },
        runtime: { port: 3000 },
        domains: ["app.example.com"],
      },
    },
  },
});
it("builds pinned source with fixed arguments and publishes routes after runtime success", async () => {
  const root = await mkdtemp(join(tmpdir(), "hotspark-"));
  const calls: string[][] = [];
  try {
    const runtime = new Runtime(root, join(root, "routes"), async (args) => {
      calls.push(args);
      return "";
    });
    await runtime.execute(operation);
    expect(calls[0]).toEqual([
      "buildx",
      "build",
      "--load",
      "--provenance=false",
      "--tag",
      `hotspark/${projectId}/web:${"a".repeat(40)}`,
      `https://github.com/example/app.git#${"a".repeat(40)}`,
    ]);
    expect(calls[1]).toContain("--wait");
    expect(
      JSON.parse(await readFile(join(root, projectId, "current.json"), "utf8")),
    ).toEqual({ deploymentId });
    expect(
      await readFile(join(root, "routes", `${projectId}.yaml`), "utf8"),
    ).toContain("app.example.com");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("does not publish routes or successful pointers after a build failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "hotspark-"));
  try {
    const runtime = new Runtime(root, join(root, "routes"), async () => {
      throw new Error("build failed");
    });
    await expect(runtime.execute(operation)).rejects.toThrow("build failed");
    expect(await readdir(join(root, "routes"))).toEqual([]);
    await expect(
      readFile(join(root, projectId, "current.json")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
