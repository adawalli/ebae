import { DEFAULT_INTERVAL } from "./poller";
import { CONDITION_KEYS, type ConditionKey } from "./types";

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
    const hasTerm = (v as string).split(/[,\n]/).some((t) => t.trim());
    out.excludeTerms = hasTerm ? v.slice(0, 500) : null; // cap: a title has nothing to match beyond this
  }
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
/* eslint-enable @typescript-eslint/no-explicit-any */
