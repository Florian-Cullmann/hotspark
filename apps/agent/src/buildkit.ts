import { mkdir, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { command, withProjectLock, type CommandRunner } from "./process.js";
import { atomicWrite } from "./runtime.js";
export const builderName = "hotspark-workloads";
export const builderImage =
  "moby/buildkit:buildx-stable-1@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8";
export async function ensureBuilder(
  run: CommandRunner = command,
  directory = "/var/lib/hotspark/buildkit",
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await withProjectLock(join(directory, ".lock"), async () => {
    const marker = await readFile(join(directory, "owner"), "utf8").catch(
      () => null,
    );
    if (marker !== builderName) {
      const existing = await run(
        "/usr/bin/docker",
        ["buildx", "inspect", builderName],
        { timeout: 10000 },
      ).then(
        () => true,
        () => false,
      );
      if (existing) throw new Error("Refusing to adopt an unowned builder");
      await run(
        "/usr/bin/docker",
        [
          "buildx",
          "create",
          "--name",
          builderName,
          "--driver",
          "docker-container",
          "--driver-opt",
          `image=${builderImage}`,
          "--driver-opt",
          "memory=4g",
          "--driver-opt",
          "cpu-period=100000",
          "--driver-opt",
          "cpu-quota=200000",
        ],
        { timeout: 60000 },
      );
      await atomicWrite(join(directory, "owner"), builderName);
    }
    await run(
      "/usr/bin/docker",
      ["buildx", "inspect", "--bootstrap", builderName],
      { timeout: 120000 },
    );
    await run(
      "/usr/bin/docker",
      ["update", "--pids-limit", "2048", `buildx_buildkit_${builderName}0`],
      { timeout: 10000 },
    );
  });
}
export const workloadCommand: CommandRunner = (exe, args, options) =>
  command(
    exe,
    exe === "/usr/bin/docker" && args[0] === "buildx" && args[1] === "build"
      ? [...args.slice(0, 2), "--builder", builderName, ...args.slice(2)]
      : args,
    options,
  );
