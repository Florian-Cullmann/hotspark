import { it, expect } from "vitest";
import {
  mkdtemp,
  readFile,
  rm,
  readdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableHash } from "../packages/providers/src/index.js";
import { Runtime } from "../apps/agent/src/runtime.js";
import { operationSchema } from "../packages/application-spec/src/index.js";
const projectId = "8fe0f734-535a-4bad-b87f-7b3c647dc4a3",
  deploymentId = "759a8e03-1b9f-40b9-a42b-b806846fc9e9";
const operation = operationSchema.parse({
  operation: "deploy",
  projectId,
  operationId: deploymentId,
  deploymentId,
  spec: {
    apiVersion: "hotspark.dev/v1",
    kind: "Application",
    metadata: { name: "test" },
    services: {
      web: {
        type: "web",
        source: {
          type: "git",
          repository: "https://github.com/example/app.git",
          commit: "a".repeat(40),
        },
        domains: ["app.example.com"],
      },
    },
  },
});
it("journals completed operations and does not replay Docker calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "hotspark-"));
  const calls: string[][] = [];
  try {
    const runtime = new Runtime(
      root,
      join(root, "routes"),
      async (args) => {
        calls.push(args);
        return "";
      },
      false,
      "b".repeat(64),
      join(root, "secrets"),
    );
    await runtime.execute(operation);
    expect(calls[0]).toContain(
      `https://github.com/example/app.git#${"a".repeat(40)}`,
    );
    const count = calls.length;
    await runtime.execute(operation);
    expect(calls).toHaveLength(count);
    expect((await runtime.status(deploymentId))?.status).toBe("succeeded");
    expect(
      await readFile(join(root, "routes", `${projectId}.yaml`), "utf8"),
    ).toContain("app.example.com");
    expect(
      await readFile(join(root, projectId, "vault.enc"), "utf8"),
    ).not.toContain("databases");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("preserves actionable failure journals without publishing routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hotspark-"));
  try {
    const runtime = new Runtime(
      root,
      join(root, "routes"),
      async () => {
        throw new Error("sensitive build error");
      },
      false,
      "b".repeat(64),
      join(root, "secrets"),
    );
    await expect(runtime.execute(operation)).rejects.toThrow(
      "Operation failed during building",
    );
    expect((await runtime.status(deploymentId))?.status).toBe("failed");
    expect(await readdir(root)).not.toContain("routes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses uncertain migration replay and operation ID reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "hotspark-journal-"));
  let calls = 0;
  try {
    const runtime = new Runtime(
      root,
      join(root, "routes"),
      async () => {
        calls++;
        return "";
      },
      false,
      "b".repeat(64),
      join(root, "secrets"),
    );
    await mkdir(join(root, ".operations"));
    await writeFile(
      join(root, ".operations", `${deploymentId}.json`),
      JSON.stringify({
        id: deploymentId,
        hash: stableHash(operation),
        status: "running",
        phase: "hook-running:web",
        progress: 65,
        hooks: [],
      }),
    );
    await expect(runtime.execute(operation)).rejects.toThrow(
      "Migration result is uncertain",
    );
    await expect(
      runtime.execute(
        operationSchema.parse({
          ...operation,
          projectId: "11111111-1111-4111-8111-111111111111",
        }),
      ),
    ).rejects.toThrow("Operation ID reused");
    expect(calls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
