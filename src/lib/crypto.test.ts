import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "./crypto";

const original = process.env.ENCRYPTION_KEY;
const setKey = () => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
};

afterEach(() => {
  if (original === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = original;
});

test("round-trips a secret for its owning user", () => {
  setKey();
  const enc = encryptSecret("ebay-client-secret", "7");
  expect(enc.startsWith("v1:")).toBe(true);
  expect(enc).not.toContain("ebay-client-secret");
  expect(decryptSecret(enc, "7")).toBe("ebay-client-secret");
});

test("random iv makes two encryptions of the same secret differ", () => {
  setKey();
  expect(encryptSecret("same", "7")).not.toBe(encryptSecret("same", "7"));
});

test("a row copied to another user fails to decrypt", () => {
  setKey();
  const enc = encryptSecret("ebay-client-secret", "7");
  expect(() => decryptSecret(enc, "8")).toThrow();
});

test("tampered ciphertext fails to decrypt", () => {
  setKey();
  const [v, iv, ct] = encryptSecret("ebay-client-secret", "7").split(":");
  const body = Buffer.from(ct, "base64");
  body[0] ^= 0xff;
  expect(() => decryptSecret(`${v}:${iv}:${body.toString("base64")}`, "7")).toThrow();
});

test("a different key fails to decrypt", () => {
  setKey();
  const enc = encryptSecret("ebay-client-secret", "7");
  setKey();
  expect(() => decryptSecret(enc, "7")).toThrow();
});

test("a key that is not 32 bytes is rejected by name", () => {
  process.env.ENCRYPTION_KEY = randomBytes(16).toString("base64");
  expect(() => encryptSecret("x", "7")).toThrow(/ENCRYPTION_KEY must decode to 32 bytes/);
});

test("a missing key is rejected by name", () => {
  delete process.env.ENCRYPTION_KEY;
  expect(() => encryptSecret("x", "7")).toThrow(/ENCRYPTION_KEY is required/);
});

test("an unknown version prefix is rejected", () => {
  setKey();
  const enc = encryptSecret("ebay-client-secret", "7");
  expect(() => decryptSecret(enc.replace(/^v1:/, "v2:"), "7")).toThrow(/v1 format/);
  expect(() => decryptSecret("not-versioned", "7")).toThrow(/v1 format/);
});
