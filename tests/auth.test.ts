import { it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  newToken,
  tokenDigest,
} from "../packages/shared/src/index.js";
it("salts and verifies memory-hard password hashes", async () => {
  const first = await hashPassword("long test password");
  const second = await hashPassword("long test password");
  expect(first).not.toBe(second);
  expect(await verifyPassword("long test password", first)).toBe(true);
  expect(await verifyPassword("incorrect", first)).toBe(false);
}, 10000);
it("uses distinct high entropy tokens and irreversible storage digests", () => {
  const a = newToken(),
    b = newToken();
  expect(a).not.toBe(b);
  expect(a.length).toBe(46);
  expect(tokenDigest(a)).toHaveLength(64);
  expect(tokenDigest(a)).not.toContain(a);
});

import { seal, unseal, redact } from "../packages/shared/src/secrets.js";
import { hasScope } from "../packages/shared/src/index.js";
it("encrypts with randomized nonces and authenticates project identity", () => {
  const key = "a".repeat(64),
    value = { API_KEY: "sensitive-value" };
  const first = seal(value, key, "project:a"),
    second = seal(value, key, "project:a");
  expect(first).not.toBe(second);
  expect(first).not.toContain(value.API_KEY);
  expect(unseal(first, key, "project:a")).toEqual(value);
  expect(() => unseal(first, key, "project:b")).toThrow();
  expect(() => unseal(first, "b".repeat(64), "project:a")).toThrow();
  expect(
    redact("sensitive-value postgresql://user:pass@db/app", [value.API_KEY]),
  ).not.toContain("pass@");
});
it("keeps fine-grained scopes separate and supports legacy tokens", () => {
  expect(hasScope(["projects:read"], "projects:create")).toBe(false);
  expect(hasScope(["projects:create"], "domains:manage")).toBe(false);
  expect(hasScope(["read"], "projects:read")).toBe(true);
  expect(hasScope(["admin"], "projects:delete")).toBe(true);
});
