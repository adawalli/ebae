import { MARKETPLACES } from "./ebay";
import { DEFAULT_INTERVAL } from "./poller";
import { splitExcludeTerms } from "./exclude-terms";
import { CONDITION_KEYS, type ConditionKey, type EbayCredsInput, type PushSub } from "./types";

// Returns an error string, or the cleaned fields. partial=true (PATCH) only
// validates the keys that are present.
/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseSearchBody(b: any, partial: boolean): string | Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!partial || b.q !== undefined) {
    const q = typeof b.q === "string" ? b.q.trim() : "";
    if (!q) return "q is required";
    out.q = q;
  }
  if (!partial || b.intervalMin !== undefined) {
    const intervalMin = Number(b.intervalMin ?? DEFAULT_INTERVAL);
    if (!Number.isInteger(intervalMin) || intervalMin < 1 || intervalMin > 60) return "intervalMin must be 1-60";
    out.intervalMin = intervalMin;
  }
  if (!partial || b.priceCap !== undefined) {
    const raw = b.priceCap;
    const priceCap = raw == null || raw === "" ? null : Number(raw);
    if (priceCap != null && (!Number.isFinite(priceCap) || priceCap <= 0)) return "priceCap must be a positive number";
    out.priceCap = priceCap;
  }
  if (!partial || b.priceFloor !== undefined) {
    const raw = b.priceFloor;
    const priceFloor = raw == null || raw === "" ? null : Number(raw);
    if (priceFloor != null && (!Number.isFinite(priceFloor) || priceFloor <= 0))
      return "priceFloor must be a positive number";
    out.priceFloor = priceFloor;
  }
  // Only cross-check when both bounds arrive together; a PATCH touching one leaves the other unknown.
  if (out.priceFloor != null && out.priceCap != null && (out.priceFloor as number) >= (out.priceCap as number))
    return "priceFloor must be less than priceCap";
  if (!partial || b.categoryId !== undefined) {
    out.categoryId = typeof b.categoryId === "string" && b.categoryId.trim() ? b.categoryId.trim() : null;
  }
  if (!partial || b.binOnly !== undefined) out.binOnly = b.binOnly === undefined ? true : !!b.binOnly;
  if (!partial || b.includeAuctions !== undefined) out.includeAuctions = !!b.includeAuctions;
  // Keep them mutually exclusive: includeAuctions is the source of truth (ebay.ts uses only it for filtering)
  if (out.binOnly !== undefined || out.includeAuctions !== undefined) {
    if (out.includeAuctions !== undefined) out.binOnly = !out.includeAuctions;
    else out.includeAuctions = !(out.binOnly as boolean);
  }
  // Whitelist, not passthrough: this value is interpolated into the eBay filter string,
  // so only the two mapped keys (or null = any) are allowed through.
  if (!partial || b.conditions !== undefined) {
    const c = b.conditions == null || b.conditions === "" ? null : String(b.conditions);
    if (c != null && !CONDITION_KEYS.includes(c as ConditionKey))
      return `conditions must be ${CONDITION_KEYS.join(", ")}, or empty`;
    out.conditions = c;
  }
  if (!partial || b.excludeTerms !== undefined) {
    const v = typeof b.excludeTerms === "string" ? b.excludeTerms.trim() : "";
    if (v.includes('"')) return "excludeTerms cannot contain double quotes";
    // Store null unless there's a real term: all-punctuation input like ",," matches
    // nothing yet would render a misleading "−0 excluded" badge if kept as a string.
    const hasTerm = splitExcludeTerms(v).length > 0;
    out.excludeTerms = hasTerm ? v.slice(0, 500) : null; // cap: a title has nothing to match beyond this
  }
  // Enabled by default on a create; omission from a patch leaves the current choice alone.
  if (!partial || b.trackSold !== undefined) out.trackSold = b.trackSold === undefined ? true : !!b.trackSold;
  if (partial && b.enabled !== undefined) out.enabled = !!b.enabled;
  return out;
}

// "HH:MM" -> minutes from midnight, or null if malformed. Exported for tests.
export function hhmmToMin(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Validates a snooze settings PUT. Returns an error string, or the cleaned config
// with start/end as minutes-from-midnight (what the poller stores).
export function parseSnoozeBody(b: any): string | { enabled: boolean; start: number; end: number; tz: string | null } {
  const start = hhmmToMin(b?.start);
  const end = hhmmToMin(b?.end);
  if (start == null || end == null) return "start and end must be HH:MM times";
  if (start === end) return "start and end must differ";
  let tz: string | null = null;
  if (b.tz != null && b.tz !== "") {
    if (typeof b.tz !== "string") return "tz must be a string";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: b.tz });
      tz = b.tz;
    } catch {
      return "tz is not a valid IANA timezone";
    }
  }
  return { enabled: !!b.enabled, start, end, tz };
}

// Validates a PUT /api/ebay-credentials body. env and marketplace are whitelisted rather than
// passed through: they pick the host the poller then sends the user's keys to, and the currency
// its price bands are expressed in. The secret is only shape-checked here - eBay itself is the
// judge of whether it's real (the route live-validates before storing).
export function parseEbayCredsBody(b: any): string | EbayCredsInput {
  const clientId = typeof b?.clientId === "string" ? b.clientId.trim() : "";
  if (!clientId) return "clientId is required";
  const clientSecret = typeof b.clientSecret === "string" ? b.clientSecret.trim() : "";
  if (!clientSecret) return "clientSecret is required";
  if (b.env !== "production" && b.env !== "sandbox") return "env must be production or sandbox";
  const marketplace = typeof b.marketplace === "string" ? b.marketplace.trim() : "";
  if (!MARKETPLACES.includes(marketplace)) return `marketplace must be one of ${MARKETPLACES.join(", ")}`;
  return { clientId, clientSecret, env: b.env, marketplace };
}

// Validates a POST /api/channels body. Discord is the only kind, and the prefix is a real
// constraint, not cosmetic: the poller POSTs to whatever is stored here, so an arbitrary URL
// would make it a request forwarder aimed at anything the pod can reach.
export function parseChannelBody(b: any): string | { webhookUrl: string } {
  const webhookUrl = typeof b?.webhookUrl === "string" ? b.webhookUrl.trim() : "";
  if (!webhookUrl.startsWith("https://discord.com/api/webhooks/"))
    return "webhookUrl must start with https://discord.com/api/webhooks/";
  return { webhookUrl };
}

// The known push services. Exact hosts, except WNS: Microsoft documents the wns2-*
// subdomain as subject to change, so that one is a suffix match. endsWith(".host") and
// never includes() - includes() would happily accept evil-fcm.googleapis.com.attacker.com.
const PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"];
const PUSH_HOST_SUFFIX = ".notify.windows.com"; // WNS (Edge on Windows)

export function pushHostAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "") return false;
  return PUSH_HOSTS.includes(u.hostname) || u.hostname.endsWith(PUSH_HOST_SUFFIX);
}

// Validates a POST /api/push body, shaped like PushSubscription.toJSON(). The endpoint is
// attacker-controlled input and the poller POSTs to whatever is stored, so the host
// allowlist is the same load-bearing SSRF guard as parseChannelBody's prefix check - it
// just has to run here, at subscribe time, because that's where the untrusted URL enters.
// The key bounds are a sanity ceiling, not a format check: RFC 8291 fixes these at 87 and
// 22 chars, but web-push rejects a malformed key on its own, so this only stops something
// absurd reaching the column.
export function parsePushBody(b: any): string | PushSub {
  const endpoint = typeof b?.endpoint === "string" ? b.endpoint.trim() : "";
  if (!endpoint) return "endpoint is required";
  if (!pushHostAllowed(endpoint)) return "endpoint is not a recognized push service";
  const p256dh = typeof b?.keys?.p256dh === "string" ? b.keys.p256dh.trim() : "";
  const auth = typeof b?.keys?.auth === "string" ? b.keys.auth.trim() : "";
  if (!p256dh || !auth) return "keys.p256dh and keys.auth are required";
  if (p256dh.length > 200 || auth.length > 100) return "keys are malformed";
  return { endpoint, p256dh, auth };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
