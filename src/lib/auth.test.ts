import { afterAll, beforeAll, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { NextResponse } from "next/server";
import { freshTestDb } from "@/__tests__/helpers/db";
import { users } from "@/lib/schema";
import { type AuthedUser, requireUser, verifyAccessJwt } from "./auth";
import { SINGLE_USER_EMAIL } from "./authmode";

// Two halves. verifyAccessJwt runs pure, against a local JWKS. requireUser's other half is a DB
// round-trip, which the PGlite harness (__tests__/helpers/db) supplies in place of DATABASE_URL -
// it provisions rows, so it has to be exercised against a real schema rather than a stub.

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

// ---------- requireUser: JIT provisioning ----------

type Globals = typeof globalThis & { __ebaeUsers?: unknown; __ebaeJwks?: JWTVerifyGetKey };
const g = globalThis as Globals;

const PROXY_HEADER = "x-forwarded-email";

afterAll(() => {
  // freshTestDb clears AUTH_MODE, but not the header var, and bun runs every test file in one
  // process.
  delete process.env.AUTH_MODE;
  delete process.env.AUTH_TRUSTED_HEADER;
});

// requireUser answers from an in-memory identity cache before it ever reaches the DB. Dropping it
// is how these tests exercise the provisioning path a later login actually takes, where the
// select-then-insert has to find the existing row rather than duplicate it.
const dropIdentityCache = () => delete g.__ebaeUsers;

const rows = (database: Awaited<ReturnType<typeof freshTestDb>>) =>
  database.select({ id: users.id, sub: users.sub, email: users.email }).from(users).orderBy(users.id);

// A 401 is the interesting failure here, so it reads back as a number; a leaked provision names
// the user it should never have created.
const outcome = (r: AuthedUser | NextResponse) => (r instanceof NextResponse ? r.status : `user ${r.email}`);

async function authed(req: Request): Promise<AuthedUser> {
  const u = await requireUser(req);
  if (u instanceof NextResponse) throw new Error(`expected a user, got ${u.status}`);
  return u;
}

const plain = () => new Request("http://localhost/api/status");
const withHeader = (name: string, value: string) =>
  new Request("http://localhost/api/status", { headers: { [name]: value } });

test("single mode provisions one users row and every later call reuses it", async () => {
  const database = await freshTestDb(); // clears AUTH_MODE, so this is single mode

  const first = await authed(plain());
  expect(first.email).toBe(SINGLE_USER_EMAIL);
  // sub stays null: single mode has no IdP to supply one.
  expect(await rows(database)).toEqual([{ id: first.id, sub: null, email: SINGLE_USER_EMAIL }]);

  expect(await authed(plain())).toEqual(first); // cache hit, no second insert
  dropIdentityCache();
  expect(await authed(plain())).toEqual(first); // and the DB path agrees after a restart
  expect(await rows(database)).toHaveLength(1);
});

test("proxy mode keys on the normalized header email, one row per identity", async () => {
  const database = await freshTestDb();
  process.env.AUTH_MODE = "proxy";
  process.env.AUTH_TRUSTED_HEADER = PROXY_HEADER;

  // Case and padding are stripped before the value becomes an identity: the same person behind a
  // proxy that shouts would otherwise provision a second row and lose every search they own.
  const alice = await authed(withHeader(PROXY_HEADER, " Alice@Example.COM "));
  expect(alice.email).toBe("alice@example.com");
  const bob = await authed(withHeader(PROXY_HEADER, "bob@example.com"));
  expect(bob.id).not.toBe(alice.id);

  dropIdentityCache();
  expect((await authed(withHeader(PROXY_HEADER, "ALICE@example.com"))).id).toBe(alice.id);
  expect(await rows(database)).toEqual([
    { id: alice.id, sub: null, email: "alice@example.com" },
    { id: bob.id, sub: null, email: "bob@example.com" },
  ]);
});

test("a cloudflare login adopts the legacy sub-less owner instead of duplicating it", async () => {
  const database = await freshTestDb();
  process.env.AUTH_MODE = "cloudflare";
  g.__ebaeJwks = keys; // remoteJwks() returns this rather than fetching Cloudflare's certs

  // What claim.ts leaves behind on an upgrade: an owner with no sub, because single mode had no
  // IdP to supply one. Email is the anchor that lets the first real login find them.
  const [legacy] = await database.insert(users).values({ email: "owner@example.com" }).returning({ id: users.id });

  const token = await sign({ email: "Owner@Example.com" });
  const user = await authed(withHeader("cf-access-jwt-assertion", token));
  expect(user.id).toBe(legacy.id);
  expect(await rows(database)).toEqual([{ id: legacy.id, sub: "sub-1", email: "owner@example.com" }]);

  // Stamped, so the select-by-sub now short-circuits the email fallback. An Access rename must
  // resolve to the same account rather than open a second one.
  dropIdentityCache();
  const renamed = await sign({ email: "owner-renamed@example.com" });
  expect((await authed(withHeader("cf-access-jwt-assertion", renamed))).id).toBe(legacy.id);
  expect(await rows(database)).toHaveLength(1);
});

test("a cloudflare identity with nobody to adopt provisions exactly one row", async () => {
  const database = await freshTestDb();
  process.env.AUTH_MODE = "cloudflare";
  g.__ebaeJwks = keys;

  const token = await sign({ email: "new@example.com" });
  const user = await authed(withHeader("cf-access-jwt-assertion", token));
  expect(await rows(database)).toEqual([{ id: user.id, sub: "sub-1", email: "new@example.com" }]);

  dropIdentityCache();
  expect((await authed(withHeader("cf-access-jwt-assertion", token))).id).toBe(user.id);
  expect(await rows(database)).toHaveLength(1);
});

// The provisioning path must sit strictly behind the assertion: a refusal that still wrote a row
// would let anyone reaching the origin seed accounts, and in cloudflare mode it would hand the
// next real login a pre-made identity.
test("a refused request provisions nobody", async () => {
  const database = await freshTestDb();
  g.__ebaeJwks = keys;

  process.env.AUTH_MODE = "cloudflare";
  expect(outcome(await requireUser(plain()))).toBe(401);
  const wrongApp = await sign({ email: "a@b.com" }, { aud: "other-app" });
  expect(outcome(await requireUser(withHeader("cf-access-jwt-assertion", wrongApp)))).toBe(401);

  process.env.AUTH_MODE = "proxy";
  process.env.AUTH_TRUSTED_HEADER = PROXY_HEADER;
  expect(outcome(await requireUser(plain()))).toBe(401);
  expect(outcome(await requireUser(withHeader(PROXY_HEADER, "   ")))).toBe(401);

  expect(await rows(database)).toEqual([]);
});
