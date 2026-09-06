import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import type { AgentOperation } from "../../application-spec/src/index.js";
export const scopes = [
  "projects:read",
  "projects:create",
  "projects:update",
  "projects:delete",
  "logs:read",
  "domains:manage",
  "system:read",
  "admin",
  "read",
  "deploy",
] as const;
export type Scope = (typeof scopes)[number];
export function tokenDigest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function newToken() {
  return `hs_${randomBytes(32).toString("base64url")}`;
}
async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, salt, hash] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;
  const actual = await derive(password, salt);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function secret(name: string) {
  const file = process.env[`${name}_FILE`];
  const value = file
    ? (await readFile(file, "utf8")).trim()
    : process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
export async function agentRequest(
  socketPath: string,
  operation: AgentOperation,
  token?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/v1/operations",
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: 900_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
          if (Buffer.byteLength(data) > 2_000_000)
            res.destroy(new Error("Agent response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200)
            return reject(
              Object.assign(new Error("Agent operation failed"), {
                statusCode: res.statusCode,
              }),
            );
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid agent response"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Agent timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(operation));
  });
}

export function hasScope(granted: string[], required: Scope) {
  const legacy: Record<string, string[]> = {
    read: ["projects:read", "logs:read"],
    deploy: [
      "projects:read",
      "projects:create",
      "projects:update",
      "projects:delete",
      "domains:manage",
    ],
  };
  return (
    granted.includes("admin") ||
    granted.includes(required) ||
    granted.some((s) => legacy[s]?.includes(required))
  );
}
