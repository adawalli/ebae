// AES-256-GCM for the eBay client secrets we store per user.
//
// The "v1:" prefix is the entire key-rotation provision: if the scheme ever changes,
// old rows stay readable while new ones are written as v2. There is no re-encryption
// tooling and no key history, by design. Losing ENCRYPTION_KEY means every user
// re-enters their eBay keys through the UI, which takes a minute. Build nothing more.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

// Read lazily, never at import: single-mode deployments use env creds and never set
// ENCRYPTION_KEY, so importing this module must not be fatal for them.
function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (!raw)
    throw new Error("ENCRYPTION_KEY is required to store eBay credentials (generate with: openssl rand -base64 32)");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${k.length} (generate with: openssl rand -base64 32)`);
  }
  return k;
}

// aad is the owning user id as a string. GCM authenticates it without storing it, so a
// ciphertext copied into another user's row fails to decrypt instead of silently working.
export function encryptSecret(plain: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(enc: string, aad: string): string {
  const [version, ivB64, ctB64] = enc.split(":");
  if (version !== "v1" || !ivB64 || !ctB64) throw new Error("encrypted value is not in v1 format");
  const iv = Buffer.from(ivB64, "base64");
  const body = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || body.length < TAG_BYTES) throw new Error("encrypted value is malformed");
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(body.subarray(body.length - TAG_BYTES));
  // Throws on tamper, wrong key, or wrong aad.
  return d.update(body.subarray(0, body.length - TAG_BYTES)).toString("utf8") + d.final("utf8");
}
