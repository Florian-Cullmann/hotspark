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
