import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
export interface CommandOptions {
  timeout?: number;
  signal?: AbortSignal;
  stream?: "stdout" | "stderr" | "both";
  onLog?: (text: string) => Promise<void>;
  workspace?: string;
}
export type CommandRunner = (
  executable: string,
  args: string[],
  options?: CommandOptions,
) => Promise<string>;
// Fixed executable/argv callers only. Output, execution time and Git workspace growth are bounded.
export const command: CommandRunner = async (
  executable,
  args,
  options = {},
) => {
  let result = Buffer.alloc(0),
    diagnostic = Buffer.alloc(0),
    failed: string | undefined;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        DOCKER_BUILDKIT: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const collect = (data: Buffer) => {
      result = Buffer.concat([result, data]).subarray(-1024 * 1024);
    };
    child.stdout.on("data", (data) => {
      diagnostic = Buffer.concat([diagnostic, data]).subarray(-1024 * 1024);
      if (options.stream !== "stderr") collect(data);
    });
    child.stderr.on("data", (data) => {
      diagnostic = Buffer.concat([diagnostic, data]).subarray(-1024 * 1024);
      if (options.stream === "stderr" || options.stream === "both")
        collect(data);
    });
    const abort = () => {
      failed = "Operation cancelled";
      kill();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => {
      failed = "Command timeout";
      kill();
    }, options.timeout ?? 840000);
    // Git's incoming pack may be adversarial. Bound fetched object storage while receiving.
    let checking = false;
    const monitor = options.workspace
      ? setInterval(() => {
          if (checking) return;
          checking = true;
          void command("/usr/bin/du", ["-sb", options.workspace!], {
            timeout: 5000,
          })
            .then((s) => {
              if (Number(s.split(/\s/)[0]) > 512 * 1024 * 1024) {
                failed = "Source workspace exceeds 512 MiB";
                kill();
              }
            })
            .catch(() => {})
            .finally(() => {
              checking = false;
            });
        }, 1000)
      : null;
    const cleanup = () => {
      clearTimeout(timeout);
      if (monitor) clearInterval(monitor);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", () => {
      cleanup();
      reject(new Error("Unable to launch operation"));
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) failed ??= `Command exited with status ${code}`;
      resolve(result.toString("utf8"));
    });
  });
  await options.onLog?.(diagnostic.toString("utf8"));
  if (failed) throw new Error(failed);
  return output;
};
export async function withProjectLock<T>(
  path: string,
  work: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const child = spawn(
    "/usr/bin/flock",
    [
      "--nonblock",
      path,
      process.execPath,
      "-e",
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () =>
      reject(
        Object.assign(new Error("Project operation is locked"), {
          statusCode: 409,
        }),
      ),
    );
  });
  try {
    return await work();
  } finally {
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.stdin.end();
    });
  }
}
export async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
