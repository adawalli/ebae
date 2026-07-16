import { eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { NextResponse } from "next/server";
import { authMode, SINGLE_USER_EMAIL } from "./authmode";
import { db } from "./db";
import { users } from "./schema";

export type AuthedUser = { id: number; email: string };

type Globals = typeof globalThis & { __ebaeJwks?: JWTVerifyGetKey; __ebaeUsers?: Map<string, AuthedUser> };
const g = globalThis as Globals;

// jose caches the fetched JWKS inside this object, so it must outlive the module: Next
// re-evaluates modules on hot reload, and a per-request set would refetch Cloudflare's
// certs on every call.
function remoteJwks(domain: string): JWTVerifyGetKey {
  return (g.__ebaeJwks ??= createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`)));
}

// LOAD-BEARING, not an optimization: the UI polls /api/status every 10s, and a users
// lookup per request would keep a connection warm around the clock and defeat Neon's
// autosuspend. Only {id,email} is cached - creds and snooze are the poller's, and they
// change under it.
function cache(): Map<string, AuthedUser> {
  return (g.__ebaeUsers ??= new Map());
}

// `keys` is a test seam (createLocalJWKSet); production always resolves the remote set.
// Env is read per call rather than at module load so tests can set it. assertAuthEnv proves
// both vars at boot, but a failed boot only records bootError - it does not stop Next serving
// routes - so neither may be assumed here. Both are checked because jose reads a falsy option
// as "don't check this claim": an empty audience would verify nothing at all, and one
// Cloudflare team signs every app's JWT with the same key and issuer, so aud is the only thing
// separating this app from the team's others. Unset must 401, not admit another app's users.
export async function verifyAccessJwt(token: string, keys?: JWTVerifyGetKey): Promise<{ sub: string; email: string }> {
  const domain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = process.env.CF_ACCESS_AUD?.trim();
  if (!domain) throw new Error("CF_ACCESS_TEAM_DOMAIN is not set");
  if (!audience) throw new Error("CF_ACCESS_AUD is not set");
  const { payload } = await jwtVerify(token, keys ?? remoteJwks(domain), {
    issuer: `https://${domain}`,
    audience,
  });
  if (!payload.sub) throw new Error("Access JWT has no sub claim");
  // Cloudflare service-token JWTs are signed by the same team JWKS and carry the same
  // issuer/audience, so this claim is the only thing separating a human from a machine:
  // Access only mints `email` for an IdP login. The user's Uptime Kuma service-token
  // policy is refused right here.
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email) throw new Error("Access JWT has no email claim");
  return { sub: payload.sub, email };
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function requireUser(req: Request): Promise<AuthedUser | NextResponse> {
  const mode = authMode();

  // The boot claim guarantees this row, which is what makes every mode share one path.
  if (mode === "single") return resolve(SINGLE_USER_EMAIL, null, SINGLE_USER_EMAIL);

  if (mode === "cloudflare") {
    // The signed assertion, never Cf-Access-Authenticated-User-Email: that header is
    // plaintext and unverifiable, so anyone reaching the origin around the tunnel could
    // set it to any allowlisted address and be that user.
    const token = req.headers.get("cf-access-jwt-assertion");
    if (!token) return unauthorized("missing Cloudflare Access assertion");
    try {
      const { sub, email } = await verifyAccessJwt(token);
      return resolve(sub, sub, email);
    } catch {
      return unauthorized("invalid Cloudflare Access assertion");
    }
  }

  // proxy: assertAuthEnv proved AUTH_TRUSTED_HEADER is set. Trusting it is only sound
  // because the app is reachable exclusively through the proxy (README says so in bold).
  const email = req.headers.get(process.env.AUTH_TRUSTED_HEADER!.trim())?.trim().toLowerCase();
  if (!email) return unauthorized("missing trusted auth header");
  return resolve(email, null, email);
}

// JIT provision. `key` is the cache key: sub where an IdP supplies one, email otherwise.
async function resolve(key: string, sub: string | null, email: string): Promise<AuthedUser> {
  const hit = cache().get(key);
  if (hit) return hit;

  const database = db();
  const cols = { id: users.id, email: users.email };
  let row = sub ? (await database.select(cols).from(users).where(eq(users.sub, sub)))[0] : undefined;

  // Fall back to email, the identity anchor. Stamping sub onto that row is how the legacy
  // owner (claimed at boot with sub null) is adopted on first login instead of being
  // duplicated.
  row ??= sub
    ? (await database.update(users).set({ sub }).where(eq(users.email, email)).returning(cols))[0]
    : (await database.select(cols).from(users).where(eq(users.email, email)))[0];

  row ??= (await database.insert(users).values({ sub, email }).onConflictDoNothing().returning(cols))[0];

  // A first page load fires three requests at once (page.tsx refresh), so a new user races
  // himself: all three miss the cache, find no row, and insert. The losers conflict away to
  // nothing and read back the winner's row here instead of 500ing on users_email_unique.
  row ??= (await database.select(cols).from(users).where(eq(users.email, email)))[0];
  if (!row) throw new Error(`could not provision user ${email}`);

  cache().set(key, row);
  return row;
}
