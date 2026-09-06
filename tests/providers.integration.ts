// Operator-only integration harness. A test runner maps fixture Git contexts to local checked-in fixtures.
// Production Runtime receives the normal Docker runner and has no local-source API.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../apps/api/src/app.js";
import { Runtime, docker } from "../apps/agent/src/runtime.js";
import {
  runOneJob,
  reconcile,
  type AgentClient,
} from "../apps/api/src/worker.js";
import { secret } from "../packages/shared/src/index.js";
import { ReleaseRuntime } from "../apps/agent/src/releases.js";
import { command } from "../apps/agent/src/process.js";
import { validateContext } from "../apps/agent/src/git.js";
import { resourceName } from "../packages/providers/src/index.js";
const db = new PrismaClient();
const root = process.env.STATE_ROOT ?? "/var/lib/hotspark/projects",
  secretRoot = "/run/hotspark-secrets";
const key = await secret("SECRETS_KEY");
const run = async (args: string[]) => {
  const mapped = args.map((a) =>
    a.startsWith("source=https://github.com/hotspark-fixtures/")
      ? `source=${join(process.cwd(), "tests/fixtures", a.split("/").at(-1)!.split(".git")[0]!)}`
      : a,
  );
  try {
    return await docker(mapped);
  } catch (e) {
    console.error(
      "Fixture Docker operation failed",
      (e as { stderr?: string }).stderr?.slice(-6000),
    );
    throw e;
  }
};
const legacy = new Runtime(
  root,
  process.env.ROUTES_ROOT ?? "/var/lib/hotspark/routes",
  run,
  false,
  key,
  secretRoot,
);
const runtime = new ReleaseRuntime(
  legacy,
  root,
  process.env.ROUTES_ROOT ?? "/var/lib/hotspark/routes",
  secretRoot,
  key,
  false,
  command,
  async (source, directory) => {
    const provider = source.repository
      .split("/")
      .at(-1)!
      .replace(/\.git$/, "");
    if (!["node", "next", "react", "pnpm", "yarn"].includes(provider))
      throw new Error("Unknown fixture");
    await cp(join(process.cwd(), "tests/fixtures", provider), directory, {
      recursive: true,
    });
    await validateContext(directory);
    return source.commit!;
  },
);
const client: AgentClient = async (op) => {
  try {
    return await runtime.execute(op);
  } catch (error) {
    throw Object.assign(error as Error, { statusCode: 500 });
  }
};
const app = await createApp(db, { secretsKey: key, agent: client });
const login = await app.inject({
  method: "POST",
  url: "/api/v1/auth/login",
  payload: {
    email: "admin@localhost",
    password: await secret("ADMIN_PASSWORD"),
  },
});
assert.equal(login.statusCode, 200, login.body);
const headers = { authorization: `Bearer ${login.json().token}` };
async function call(
  url: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  payload?: unknown,
) {
  const response = await app.inject({
    method,
    url: `/api/v1/${url}`,
    headers,
    ...(payload ? { payload } : {}),
  });
  assert.ok(response.statusCode < 300, response.body);
  return response.json();
}
const created: string[] = [];
try {
  const candidates = ["node", "next", "react", "pnpm", "yarn"] as const;
  for (const provider of candidates.filter(
    (p) =>
      !process.env.TEST_PROVIDERS ||
      process.env.TEST_PROVIDERS.split(",").includes(p),
  )) {
    const withDatabase = provider === "node" || provider === "next";
    const name = `provider-${provider}-${randomUUID().slice(0, 8)}`;
    const spec = {
      apiVersion: "hotspark.dev/v1",
      kind: "Application",
      metadata: { name },
      services: {
        web: {
          type:
            provider === "next"
              ? "nextjs"
              : provider === "pnpm" || provider === "yarn"
                ? "node"
                : provider,
          source: {
            type: "git",
            repository: `https://github.com/hotspark-fixtures/${provider}.git`,
            commit: "a".repeat(40),
          },
          build: {
            standalone: provider === "next",
            packageManager:
              provider === "pnpm" || provider === "yarn" ? provider : "npm",
            nodeVersion: provider === "pnpm" ? "22" : "24",
          },
          runtime: { port: 3000 },
          domains: [`${name}.example.com`],
          ...(!withDatabase
            ? {}
            : {
                database: "database",
                secrets: ["API_KEY"],
                environment: { GREETING: "hello-$literal" },
                hooks: [{ type: "prisma-migrate-deploy" }],
              }),
        },
        ...(!withDatabase
          ? {}
          : {
              database: {
                type: "postgres",
                version: provider === "next" ? "18" : "16",
              },
            }),
      },
    };
    const result = await call("projects", "POST", {
      spec,
      secrets: !withDatabase
        ? {}
        : { web: { API_KEY: "fixture-sensitive-value" } },
    });
    created.push(result.projectId);
    await runOneJob(db, client);
    const job = await call(`jobs/${result.jobId}`);
    assert.equal(job.status, "succeeded", JSON.stringify(job));
    const inspect = (await client({
      operation: "inspect",
      projectId: result.projectId,
    })) as { state: string };
    assert.equal(inspect.state, "running");
    const active = JSON.parse(
      await readFile(
        join(root, result.projectId, "release-state.json"),
        "utf8",
      ),
    ).active;
    const plan = active.plan;
    const compose = await readFile(active.compose, "utf8");
    assert.ok(!compose.includes("fixture-sensitive-value"));
    assert.ok(!compose.includes("postgresql://"));
    assert.ok(
      !(
        await readFile(join(root, result.projectId, "vault.enc"), "utf8")
      ).includes("fixture-sensitive-value"),
    );
    if (withDatabase) {
      if (provider === "node") {
        await docker([
          "exec",
          `hs-${result.projectId}-${plan.services.find((s: { name: string }) => s.name === "web").id}-1`,
          "node",
          "-e",
          "require('fs').writeFileSync('/proc/1/fd/1', 'x'.repeat(400000)+'fixture-sensitive-value\\n')",
        ]);
      }
      const logs = (await client({
        operation: "logs",
        projectId: result.projectId,
        service: "web",
        lines: 100,
        stream: "both",
      })) as { text: string };
      assert.ok(!logs.text.includes("fixture-sensitive-value"));
      assert.ok(Buffer.byteLength(logs.text) <= 256 * 1024);
      if (provider === "node") assert.ok(logs.text.includes("[REDACTED]"));
      const webId = plan.services.find(
          (s: { name: string }) => s.name === "web",
        ).id,
        dbId = resourceName(result.projectId, "database");
      const ps = JSON.parse(
        await docker(["inspect", `hs-${result.projectId}-${dbId}-1`]),
      );
      assert.deepEqual(Object.keys(ps[0].NetworkSettings.Networks), [
        `hs-${result.projectId}_private`,
      ]);
      const env = JSON.parse(
        await docker(["inspect", `hs-${result.projectId}-${webId}-1`]),
      )[0].Config.Env.join("\n");
      assert.ok(!env.includes("fixture-sensitive-value"));
      assert.ok(!env.includes("DATABASE_URL="));
      assert.ok(env.includes("GREETING=hello-$literal"));
      const restart = await call(
        `projects/${result.projectId}/restart`,
        "POST",
      );
      await runOneJob(db, client);
      assert.equal((await call(`jobs/${restart.jobId}`)).status, "succeeded");
      // Out-of-band drift is observed and repaired according to desired state.
      await docker([
        "compose",
        "-p",
        `hs-${result.projectId}`,
        "-f",
        active.compose,
        "stop",
      ]);
      await docker([
        "compose",
        "-p",
        `hs-${result.projectId}`,
        "-f",
        join(root, result.projectId, "infrastructure.json"),
        "stop",
      ]);
      await reconcile(db, client);
      await runOneJob(db, client);
      assert.equal(
        (await call(`projects/${result.projectId}`)).observedState,
        "running",
      );
    }
    console.log(
      `Provider passed: ${provider}, ${result.projectId}, ${plan.services.length} services`,
    );
  }
  await mkdir("/tmp/hotspark-test-results", { recursive: true });
  console.log(
    `Real provider integration passed for ${process.env.TEST_PROVIDERS || candidates.join(", ")}; fixture data retained.`,
  );
} finally {
  // Destructive data cleanup is deliberately not automatic: preserve fixtures for inspection.
  console.log("Preserved fixture project IDs:", created.join(", "));
  await app.close();
  await db.$disconnect();
}
