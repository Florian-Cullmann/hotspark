#!/usr/bin/env node
import {
  readFile,
  realpath,
  mkdir,
  chmod,
  writeFile,
  rename,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";
import { HotsparkClient } from "../../sdk/src/index.js";
import { applicationSpecSchema } from "../../application-spec/src/index.js";

export function serverUrl(input: string) {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use a server origin without credentials, path, or query");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("HTTPS is required except for loopback/SSH tunnels");
  return url.origin;
}
export function parseSpec(input: string) {
  if (Buffer.byteLength(input) > 128 * 1024)
    throw new Error("Specification exceeds 128 KiB");
  const doc = parseDocument(input, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Invalid YAML specification");
  return applicationSpecSchema.parse(doc.toJS({ maxAliasCount: 20 }));
}
// Control characters from workload logs must never become terminal escape sequences.
export function terminalSafe(text: string) {
  // eslint-disable-next-line no-control-regex -- strip hostile terminal control bytes
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
export function logOverlap(previous: string, next: string) {
  if (!next) return 0;
  const prefix = new Int32Array(next.length);
  for (let i = 1, k = 0; i < next.length; i++) {
    while (k && next[i] !== next[k]) k = prefix[k - 1]!;
    if (next[i] === next[k]) k++;
    prefix[i] = k;
  }
  let k = 0;
  for (let i = 0; i < previous.length; i++) {
    const char = previous[i];
    while (k && (k === next.length || next[k] !== char)) k = prefix[k - 1]!;
    if (next[k] === char) k++;
  }
  return k;
}
const output = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
async function stdin() {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > 4096) throw new Error("Credential input too long");
  }
  return value.trim();
}
async function passwordPrompt() {
  if (!process.stdin.isTTY)
    throw new Error(
      "Use --token-stdin or --password-stdin for piped credentials",
    );
  process.stdout.write("Password: ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", input);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const input = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          finish(new Error("Login cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
        if (value.length > 1024) {
          finish(new Error("Password too long"));
          return;
        }
      }
    };
    process.stdin.on("data", input);
  });
}
export async function main(args = process.argv.slice(2)) {
  const [command, sub, arg] = args;
  const config =
    process.env.HOTSPARK_CONFIG ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "hotspark",
      "config.json",
    );
  if (!command || command === "help" || command === "--help") {
    console.log(`platform login URL --token-stdin | --password-stdin [--email ADDRESS]
platform project list | create app.yaml
platform deploy|start|stop|restart PROJECT
platform logs PROJECT --service NAME [--follow] [--lines 100]
platform maintenance enable|disable PROJECT
platform rollback PROJECT [--deployment UUID]
platform doctor
platform backup [PROJECT]
platform gc PROJECT [--apply] [--retain 5]
platform update VERSION --sha256 TRUSTED_SHA256
platform task UUID
platform logout
Set HOTSPARK_URL and HOTSPARK_TOKEN for non-interactive automation.
Mutations return a durable job/task reference; --idempotency-key KEY is supported.`);
    return;
  }
  const option = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing ${name} value`);
    return value;
  };
  if (command === "login") {
    const url = serverUrl(sub ?? "");
    const piped =
      args.includes("--token-stdin") || args.includes("--password-stdin");
    if (piped && process.stdin.isTTY)
      throw new Error(
        "Pipe credentials through stdin or omit the stdin flag for an interactive login",
      );
    let token = piped ? await stdin() : await passwordPrompt();
    if (!args.includes("--token-stdin")) {
      const response = await fetch(`${url}/api/v1/auth/login`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: option("--email") ?? "admin@localhost",
          password: token,
        }),
      });
      if (!response.ok) throw new Error(`Login failed (${response.status})`);
      token = (await response.json()).token;
    }
    if (!/^hs_[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error("Invalid token format");
    await new HotsparkClient(url, token).request("auth/session");
    await mkdir(dirname(config), { recursive: true, mode: 0o700 });
    await chmod(dirname(config), 0o700);
    const temp = `${config}.${randomUUID()}`;
    await writeFile(temp, JSON.stringify({ url, token }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, config);
    console.log("Login saved with owner-only permissions.");
    return;
  }
  let saved: { url?: string; token?: string } = {};
  if (!process.env.HOTSPARK_TOKEN) {
    const info = await stat(config);
    if ((info.mode & 0o077) !== 0)
      throw new Error("Credential file must have mode 0600");
    saved = JSON.parse(await readFile(config, "utf8"));
  }
  const url = serverUrl(process.env.HOTSPARK_URL ?? saved.url ?? ""),
    token = process.env.HOTSPARK_TOKEN ?? saved.token;
  if (!token)
    throw new Error("Login first or set HOTSPARK_URL and HOTSPARK_TOKEN");
  const client = new HotsparkClient(url, token);
  const mutation = {
    method: "POST",
    headers: { "Idempotency-Key": option("--idempotency-key") ?? randomUUID() },
  };
  const project = async (name: string | undefined) => {
    if (!name) throw new Error("Project name or UUID required");
    if (/^[0-9a-f-]{36}$/.test(name)) return name;
    const matches = (await client.projects()).filter((p) => p.name === name);
    if (matches.length !== 1)
      throw new Error(
        "Project not found; use its UUID when outside the first page",
      );
    return matches[0]!.id;
  };
  if (command === "logout") {
    await client.request("auth/logout", { method: "POST" });
    await writeFile(config, "{}", { mode: 0o600 });
    console.log("Session revoked.");
  } else if (command === "doctor")
    output(await client.request("system/doctor"));
  else if (command === "task")
    output(
      await client.request(`system/tasks/${encodeURIComponent(sub ?? "")}`),
    );
  else if (command === "project" && sub === "list")
    output(await client.projects());
  else if (command === "project" && sub === "create") {
    if (!arg || (await stat(arg)).size > 128 * 1024)
      throw new Error("Provide a specification file up to 128 KiB");
    output(
      await client.createProject(
        parseSpec(await readFile(arg, "utf8")),
        {},
        mutation.headers["Idempotency-Key"],
      ),
    );
  } else if (["deploy", "start", "stop", "restart"].includes(command)) {
    const id = await project(sub);
    output(
      await client.request(
        `projects/${id}/${command === "deploy" ? "deployments" : command}`,
        mutation,
      ),
    );
  } else if (command === "maintenance") {
    if (!["enable", "disable"].includes(sub ?? ""))
      throw new Error("Choose enable or disable");
    output(
      await client.maintenance(
        await project(arg),
        sub === "enable",
        mutation.headers["Idempotency-Key"],
      ),
    );
  } else if (command === "rollback") {
    const id = await project(sub);
    const current = await client.request<{ activeDeploymentId: string }>(
      `projects/${id}`,
    );
    const active = await client.request<{ previousReleaseId?: string }>(
      `deployments/${current.activeDeploymentId}`,
    );
    const target = option("--deployment") ?? active.previousReleaseId;
    if (!target)
      throw new Error("No previous release; specify --deployment UUID");
    output(
      await client.rollback(id, target, mutation.headers["Idempotency-Key"]),
    );
  } else if (command === "logs") {
    const id = await project(sub),
      service = option("--service");
    if (!service) throw new Error("--service is required");
    const lines = Number(option("--lines") ?? 100);
    if (!Number.isInteger(lines) || lines < 1 || lines > 1000)
      throw new Error("--lines must be 1–1000");
    let previous = "";
    do {
      const data = await client.request<{ text: string }>(
        `projects/${id}/logs?${new URLSearchParams({ service, lines: String(lines) })}`,
      );
      // Bounded polling: emit overlap-free suffix, tolerate rotation/restarts. This is not lossless streaming.
      const overlap = logOverlap(previous, data.text);
      process.stdout.write(terminalSafe(data.text.slice(overlap)));
      previous = data.text;
      if (!args.includes("--follow")) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } while (args.includes("--follow"));
  } else if (command === "backup") {
    output(
      await client.request("system/backups", {
        ...mutation,
        body: JSON.stringify(sub ? { projectId: await project(sub) } : {}),
      }),
    );
  } else if (command === "gc") {
    output(
      await client.request("system/garbage-collections", {
        ...mutation,
        body: JSON.stringify({
          projectId: await project(sub),
          dryRun: !args.includes("--apply"),
          buildCache: args.includes("--build-cache"),
          retain: Number(option("--retain") ?? 5),
        }),
      }),
    );
  } else if (command === "update") {
    output(
      await client.request("system/updates", {
        ...mutation,
        body: JSON.stringify({ version: sub, sha256: option("--sha256") }),
      }),
    );
  } else throw new Error("Unknown command; run platform help");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(await realpath(process.argv[1])).href
)
  main().catch((error: unknown) => {
    console.error(
      terminalSafe(error instanceof Error ? error.message : "Command failed"),
    );
    process.exitCode = 1;
  });
