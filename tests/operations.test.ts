import {
  publicAddress,
  webhookAdapter,
} from "../apps/api/src/notifications.js";
import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  serverUrl,
  parseSpec,
  terminalSafe,
  logOverlap,
} from "../packages/cli/src/main.js";
import { Operations, retainedReleases } from "../apps/agent/src/operations.js";
import { operationSchema } from "../packages/application-spec/src/index.js";
import type { ReleaseRecord } from "../apps/agent/src/releases.js";
it("CLI rejects credential-bearing/insecure origins and ambiguous YAML", () => {
  expect(serverUrl("https://host.example.com")).toBe(
    "https://host.example.com",
  );
  expect(serverUrl("http://127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
  for (const origin of [
    "http://host.example.com",
    "https://user:pass@host.example.com",
    "https://host.example.com/other",
    "file:///tmp/key",
  ])
    expect(() => serverUrl(origin)).toThrow();
  expect(() => parseSpec("metadata: {}\nmetadata: {}\n")).toThrow();
  expect(terminalSafe("\x1b[31msecret\x07\n")).toBe("[31msecret\n");
});
it("operational protocol accepts intent but rejects host paths, shells, URLs and unsafe retention", () => {
  const taskId = randomUUID(),
    projectId = randomUUID();
  expect(
    operationSchema.safeParse({ operation: "backup", taskId, projectId })
      .success,
  ).toBe(true);
  for (const input of [
    { operation: "backup", taskId, output: "/etc/passwd" },
    { operation: "garbage-collect", taskId, projectId, retain: 0 },
    {
      operation: "platform-update",
      taskId,
      version: "1.0.0",
      sha256: "a".repeat(64),
      url: "http://169.254.169.254",
    },
  ])
    expect(operationSchema.safeParse(input).success).toBe(false);
});
it("retention protects active, previous and successful rollback history regardless of failed attempts", () => {
  const records = [
    "failed",
    "failed",
    "active",
    "superseded",
    "rolled_back",
  ].map((status, i) => ({
    id: String(i),
    status,
    createdAt: String(9 - i),
  })) as ReleaseRecord[];
  expect([
    ...retainedReleases(records, "old-active", "old-previous", 2),
  ]).toEqual(["old-active", "old-previous", "2", "3"]);
});
it("a failed dump never creates a successful manifest and failure is durably journaled", async () => {
  const root = await mkdtemp(join(tmpdir(), "hotspark-backup-")),
    taskId = randomUUID();
  const runtime = new Operations(
    { execute: async () => ({}) },
    root,
    async () => {
      throw new Error("sensitive backend diagnostic");
    },
  );
  try {
    await expect(
      runtime.execute({ operation: "backup", taskId }),
    ).rejects.toThrow("Operational task failed");
    const journal = await runtime.execute({
      operation: "system-task-status",
      taskId,
    });
    expect(JSON.stringify(journal)).not.toContain("sensitive");
    expect(journal).toMatchObject({ status: "failed" });
    await expect(
      readFile(join(root, "backups", taskId, "manifest.json")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("GC excludes runtime-referenced and retained images and never prunes volumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hotspark-gc-")),
    projectId = randomUUID(),
    taskId = randomUUID(),
    releaseId = randomUUID();
  const directory = join(root, "projects", projectId),
    kept = `sha256:${"a".repeat(64)}`,
    unused = `sha256:${"b".repeat(64)}`,
    used = `sha256:${"c".repeat(64)}`;
  await mkdir(join(directory, "releases", releaseId), { recursive: true });
  await writeFile(
    join(directory, "release-state.json"),
    JSON.stringify({ active: { id: releaseId }, previous: null }),
  );
  await writeFile(
    join(directory, "releases", releaseId, "release.json"),
    JSON.stringify({
      id: releaseId,
      status: "active",
      createdAt: new Date().toISOString(),
      images: [{ digest: kept }],
      plan: { services: [] },
    }),
  );
  const calls: string[][] = [];
  const runtime = new Operations(
    { execute: async () => ({}) },
    root,
    async (_exe, args) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "ls")
        return [kept, unused, used].join("\n");
      if (args[0] === "ps")
        return args.at(-1) === `ancestor=${used}` ? "container" : "";
      return "";
    },
  );
  try {
    const result = await runtime.execute({
      operation: "garbage-collect",
      taskId,
      projectId,
      retain: 5,
      buildCache: false,
      dryRun: true,
    });
    expect(result).toMatchObject({
      images: [unused],
      volumesRemoved: 0,
      dryRun: true,
    });
    expect(calls.some((a) => a.includes("rm") || a.includes("prune"))).toBe(
      false,
    );
    const count = calls.length;
    expect(
      await runtime.execute({
        operation: "garbage-collect",
        taskId,
        projectId,
        retain: 5,
        buildCache: false,
        dryRun: true,
      }),
    ).toEqual(result);
    expect(calls.length).toBe(count);
    await expect(
      runtime.execute({
        operation: "garbage-collect",
        taskId,
        projectId,
        retain: 5,
        buildCache: false,
        dryRun: false,
      }),
    ).rejects.toThrow("Task ID reused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("webhooks reject private, link-local, loopback, mapped addresses and credential URLs", () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "::ffff:127.0.0.1",
    "::1",
    "100.64.0.1",
  ])
    expect(publicAddress(address)).toBe(false);
  expect(publicAddress("1.1.1.1")).toBe(true);
  expect(() =>
    webhookAdapter("https://user:pass@example.com", "a".repeat(64)),
  ).toThrow();
});

it("an interrupted backup is classified without replaying a possibly live dump", async () => {
  const { stableHash } = await import("../packages/providers/src/index.js");
  const root = await mkdtemp(join(tmpdir(), "hotspark-interrupted-backup-"));
  const op = { operation: "backup" as const, taskId: randomUUID() };
  await mkdir(join(root, "operations"));
  await writeFile(
    join(root, "operations", `${op.taskId}.json`),
    JSON.stringify({ status: "running", hash: stableHash(op) }),
  );
  let calls = 0;
  const runtime = new Operations(
    { execute: async () => ({}) },
    root,
    async () => {
      calls++;
      return "";
    },
  );
  try {
    await expect(runtime.execute(op)).rejects.toThrow("Interrupted backup");
    expect(calls).toBe(0);
    expect(
      await runtime.execute({
        operation: "system-task-status",
        taskId: op.taskId,
      }),
    ).toMatchObject({ status: "failed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounded log polling finds overlap in linear time for repetitive output", () => {
  expect(logOverlap("old\nshared\n", "shared\nnew\n")).toBe(7);
  expect(logOverlap("a".repeat(200000), "a".repeat(200000))).toBe(200000);
  expect(logOverlap("old", "new")).toBe(0);
});
