import { DEFAULT_INTERVAL } from "./poller";

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
  if (partial && b.enabled !== undefined) out.enabled = !!b.enabled;
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
