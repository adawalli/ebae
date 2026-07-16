// Auth mode resolution, kept dependency-free so claim.ts/auth.ts/poller.ts can all
// import it without cycles.

export type AuthMode = "single" | "cloudflare" | "proxy";

// The implicit single-mode user. Not a real mailbox, just the identity anchor for the
// one users row every code path resolves against.
export const SINGLE_USER_EMAIL = "local@localhost";

// "single" is the default because this is OSS: someone running ebae on localhost or a
// LAN must get today's behaviour with zero new env vars. Multi-user is opt-in.
export function authMode(): AuthMode {
  const raw = process.env.AUTH_MODE?.trim();
  if (!raw) return "single";
  if (raw === "single" || raw === "cloudflare" || raw === "proxy") return raw;
  throw new Error(`AUTH_MODE must be "single", "cloudflare" or "proxy" (got "${raw}")`);
}

// Fail closed at boot: a multi-user mode missing its config would otherwise 401 every
// request, or worse, trust an unverifiable header. Single mode logs its no-auth warning
// from the poller at boot, not here.
export function assertAuthEnv(): void {
  const mode = authMode();
  const missing = (v: string) => !process.env[v]?.trim();
  if (mode === "cloudflare") {
    for (const v of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"]) {
      if (missing(v)) throw new Error(`AUTH_MODE=cloudflare requires ${v}`);
    }
  }
  if (mode === "proxy" && missing("AUTH_TRUSTED_HEADER")) {
    throw new Error("AUTH_MODE=proxy requires AUTH_TRUSTED_HEADER");
  }
}
