import { beforeAll, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { verifyAccessJwt } from "./auth";

// Only verifyAccessJwt is exercised: requireUser's other half is a DB round-trip, and
// tests have no DATABASE_URL.

const DOMAIN = "team.cloudflareaccess.com";
const ISS = `https://${DOMAIN}`;
const AUD = "aud-tag";

let sign: (
  claims: Record<string, unknown>,
  opts?: { iss?: string; aud?: string | string[]; exp?: string },
) => Promise<string>;
let keys: JWTVerifyGetKey;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  keys = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", kid: "test" }] });
  sign = (claims, opts = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(opts.iss ?? ISS)
      .setAudience(opts.aud ?? AUD)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "5m")
      .setSubject("sub-1")
      .sign(privateKey);
});

beforeAll(() => {
  process.env.CF_ACCESS_TEAM_DOMAIN = DOMAIN;
  process.env.CF_ACCESS_AUD = AUD;
});

test("accepts a valid Access JWT and lowercases the email", async () => {
  const token = await sign({ email: "Friend@Example.COM" });
  expect(await verifyAccessJwt(token, keys)).toEqual({ sub: "sub-1", email: "friend@example.com" });
});

test("rejects a wrong audience", async () => {
  const token = await sign({ email: "a@b.com" }, { aud: "other-app" });
  await expect(verifyAccessJwt(token, keys)).rejects.toThrow();
});

// Cloudflare mints aud as a one-element ARRAY, not the bare string every other test signs
// here ({"aud":["1d7ae..."],"iss":"https://bytefit.cloudflareaccess.com","type":"app"}).
// A verifier that string-compared the claim would reject every real token while the whole
// local suite stayed green.
test("accepts the array-shaped aud Cloudflare actually sends", async () => {
  const token = await sign({ email: "a@b.com" }, { aud: [AUD] });
  expect(await verifyAccessJwt(token, keys)).toEqual({ sub: "sub-1", email: "a@b.com" });
});

// The array form must not become a bypass: a token for a DIFFERENT app in the same team is
// still signed by the same JWKS with the same issuer, so aud membership is the only refusal.
test("rejects an array aud that does not contain our tag", async () => {
  const token = await sign({ email: "a@b.com" }, { aud: ["other-app", "third-app"] });
  await expect(verifyAccessJwt(token, keys)).rejects.toThrow();
});

// The aud is all that separates this app from every other one in the team - they share a JWKS
// and an issuer - and jose skips the check entirely when the option is falsy. An unset var must
// refuse the token rather than accept any Access app's.
test("rejects when CF_ACCESS_AUD is unset", async () => {
  const token = await sign({ email: "a@b.com" }, { aud: "some-other-app" });
  delete process.env.CF_ACCESS_AUD;
  try {
    await expect(verifyAccessJwt(token, keys)).rejects.toThrow("CF_ACCESS_AUD");
  } finally {
    process.env.CF_ACCESS_AUD = AUD;
  }
});

test("rejects a wrong issuer", async () => {
  const token = await sign({ email: "a@b.com" }, { iss: "https://evil.cloudflareaccess.com" });
  await expect(verifyAccessJwt(token, keys)).rejects.toThrow();
});

test("rejects an expired token", async () => {
  const token = await sign({ email: "a@b.com" }, { exp: "-1s" });
  await expect(verifyAccessJwt(token, keys)).rejects.toThrow();
});

// A service token (e.g. the Uptime Kuma Service Auth policy) is signed by the same team
// JWKS with the same iss/aud - the absent email claim is what refuses it.
test("rejects a token with no email claim", async () => {
  const token = await sign({ common_name: "uptime-kuma.token" });
  await expect(verifyAccessJwt(token, keys)).rejects.toThrow("no email claim");
});
