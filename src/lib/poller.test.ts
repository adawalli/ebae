import { expect, test } from "bun:test";
import {
  baselineInvalidated,
  excludeMatch,
  healthWindowMs,
  inWindow,
  matchCriteriaChanged,
  median,
  mergeCalls,
  snoozeMinutes,
} from "./poller";
import { dealField } from "./discord";
import { hhmmToMin, parseSearchBody, parseSnoozeBody } from "./validate";
import type { Item } from "./types";

// The re-seed guard in updateSearch: editing what a search matches must reset the
// seeded baseline, but touching only interval/enabled (or a no-op edit) must not.
const cur = {
  q: "Leica M6",
  categoryId: null,
  priceFloor: null,
  priceCap: 2500,
  binOnly: true,
  includeAuctions: false,
  conditions: null,
};

test("changing a match field re-seeds", () => {
  expect(matchCriteriaChanged(cur, { q: "Leica M3" })).toBe(true);
  expect(matchCriteriaChanged(cur, { priceCap: 3000 })).toBe(true);
  expect(matchCriteriaChanged(cur, { priceFloor: 100 })).toBe(true); // null -> value
  expect(matchCriteriaChanged(cur, { categoryId: "625" })).toBe(true);
  expect(matchCriteriaChanged(cur, { includeAuctions: true })).toBe(true);
  expect(matchCriteriaChanged(cur, { conditions: "NEW" })).toBe(true); // server-side filter
});

// baselineInvalidated: the market baseline is sampled against the match criteria AND
// filtered through excludeMatch, so any of those changing must reset it. Unlike re-seeding,
// an excludeTerms change counts here (the sample is exclude-filtered) but a no-op edit must not.
const curEx = { ...cur, excludeTerms: "for parts, repro" };
test("baselineInvalidated: match-field OR excludeTerms change resets the market baseline", () => {
  expect(baselineInvalidated(curEx, { priceCap: 3000 })).toBe(true); // match field
  expect(baselineInvalidated(curEx, { conditions: "NEW" })).toBe(true); // match field
  expect(baselineInvalidated(curEx, { excludeTerms: "for parts" })).toBe(true); // exclude changed
  expect(baselineInvalidated(curEx, { excludeTerms: "for parts, repro" })).toBe(false); // same value, no-op
  expect(baselineInvalidated(curEx, { intervalMin: 10, enabled: false })).toBe(false); // neither
  expect(baselineInvalidated(curEx, {})).toBe(false);
});

test("no-op or non-match edits do not re-seed", () => {
  expect(matchCriteriaChanged(cur, { q: "Leica M6", priceCap: 2500 })).toBe(false); // same values
  expect(matchCriteriaChanged(cur, { intervalMin: 10, enabled: false })).toBe(false); // not match fields
  expect(matchCriteriaChanged(cur, { excludeTerms: "for parts" })).toBe(false); // client-side, seen stays complete
  expect(matchCriteriaChanged(cur, { conditions: null })).toBe(false); // unchanged
  expect(matchCriteriaChanged(cur, {})).toBe(false);
});

// excludeMatch: the client-side negative-keyword filter. A false negative spams the
// user with junk; a false positive silently drops a wanted listing.
test("excludeMatch: case-insensitive substring across comma/newline terms", () => {
  expect(excludeMatch("Leica M6 - FOR PARTS", "for parts, repro")).toBe(true);
  expect(excludeMatch("Nikon repro plate", "for parts\nrepro")).toBe(true);
  expect(excludeMatch("Leica M6 mint boxed", "for parts, repro")).toBe(false);
  expect(excludeMatch("anything", null)).toBe(false);
  expect(excludeMatch("anything", "  , \n ")).toBe(false); // all-empty terms match nothing
});

// median: the "typical price" for deal context. Even counts average the two middles.
test("median: odd, even, empty, NaN-filtered", () => {
  expect(median([5])).toBe(5);
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([])).toBeNull();
  expect(median([NaN, 2, 4])).toBe(3);
});

// dealField: the embed's "is this a deal?" line. Gated on a real sample so a single
// prior alert can't masquerade as "typical".
const mkItem = (price: number | null): Item => ({
  itemId: "x",
  title: "t",
  price,
  currency: "USD",
  shippingCost: null,
  buyingOption: "FIXED_PRICE",
  condition: null,
  imageUrl: null,
  itemUrl: "u",
});
test("dealField: null until 3+ priced samples with a price and baseline", () => {
  expect(dealField(mkItem(400), { typical: 500, count: 2, basis: "recent" })).toBeNull(); // too few
  expect(dealField(mkItem(null), { typical: 500, count: 9, basis: "recent" })).toBeNull(); // no listing price
  expect(dealField(mkItem(400), { typical: null, count: 9, basis: "recent" })).toBeNull(); // no baseline
  expect(dealField(mkItem(400), { typical: 0, count: 9, basis: "recent" })).toBeNull(); // zero baseline -> no divide-by-zero
  expect(dealField(mkItem(400), undefined)).toBeNull();
});
test("dealField: signed delta vs typical", () => {
  expect(dealField(mkItem(400), { typical: 500, count: 5, basis: "recent" })).toEqual({
    name: "Typical",
    value: "$500.00 · ▼ 20% under",
    inline: true,
  });
  expect(dealField(mkItem(550), { typical: 500, count: 5, basis: "recent" })).toEqual({
    name: "Typical",
    value: "$500.00 · ▲ 10% over",
    inline: true,
  });
  expect(dealField(mkItem(500), { typical: 500, count: 5, basis: "recent" })).toEqual({
    name: "Typical",
    value: "$500.00 · ≈ typical",
    inline: true,
  });
});
// Market basis: a dedicated unfiltered sample, so it shows from the first alert (no count
// gate) and is labeled "Market". This is the whole point of option 2 — a 100-300 deal-hunt
// on an item that lists ~500 gets true market context its own in-band alerts can't give.
test("dealField: market basis labels 'Market' and needs no sample count", () => {
  expect(dealField(mkItem(250), { typical: 500, count: 0, basis: "market" })).toEqual({
    name: "Market",
    value: "$500.00 · ▼ 50% under",
    inline: true,
  });
  expect(dealField(mkItem(250), { typical: 0, count: 9, basis: "market" })).toBeNull(); // still no divide-by-zero
});

// parseSearchBody: the API trust boundary for the two new fields. conditions is
// interpolated into the eBay filter, so anything but the whitelist must be rejected.
test("parseSearchBody: conditions whitelist and excludeTerms trim/cap", () => {
  const ok = parseSearchBody({ q: "x", conditions: "NEW", excludeTerms: " for parts, repro " }, false) as Record<
    string,
    unknown
  >;
  expect(ok.conditions).toBe("NEW");
  expect(ok.excludeTerms).toBe("for parts, repro");
  expect(typeof parseSearchBody({ q: "x", conditions: "1000|3000" }, false)).toBe("string"); // injection rejected
  expect((parseSearchBody({ conditions: "" }, true) as Record<string, unknown>).conditions).toBeNull();
  expect((parseSearchBody({ excludeTerms: "   " }, true) as Record<string, unknown>).excludeTerms).toBeNull();
  expect((parseSearchBody({ excludeTerms: ",," }, true) as Record<string, unknown>).excludeTerms).toBeNull(); // no real term
  const long = parseSearchBody({ excludeTerms: "a".repeat(999) }, true) as Record<string, unknown>;
  expect((long.excludeTerms as string).length).toBe(500);
});

test("undefined current (boot window) treats any provided field as changed", () => {
  expect(matchCriteriaChanged(undefined, { q: "anything" })).toBe(true);
});

// mergeCalls restores the persisted daily API count on reload without letting a
// stale DB snapshot clobber the live in-memory counter.
const TODAY = "Mon Jul 06 2026";
test("fresh boot adopts the persisted count", () => {
  expect(mergeCalls({ date: TODAY, used: 0 }, TODAY, 4000)).toEqual({ date: TODAY, used: 4000 });
});
test("live refresh keeps the larger in-memory count (un-flushed increments)", () => {
  expect(mergeCalls({ date: TODAY, used: 4500 }, TODAY, 4000)).toEqual({ date: TODAY, used: 4500 });
});
test("day rollover discards the stale prior-day count", () => {
  expect(mergeCalls({ date: "Sun Jul 05 2026", used: 4999 }, TODAY, 0)).toEqual({ date: TODAY, used: 0 });
});

// Snooze window membership. Guards the quota saver: an off-by-one boundary or a
// broken midnight-crossing check silently changes when the eBay API gets hit.
test("inWindow: start inclusive, end exclusive", () => {
  expect(inWindow(60, 420, 60)).toBe(true); // 01:00 - in
  expect(inWindow(60, 420, 419)).toBe(true); // 06:59 - in
  expect(inWindow(60, 420, 420)).toBe(false); // 07:00 - out
  expect(inWindow(60, 420, 59)).toBe(false); // 00:59 - out
});
test("inWindow: window crossing midnight", () => {
  expect(inWindow(1320, 360, 1350)).toBe(true); // 22:00-06:00 @ 22:30
  expect(inWindow(1320, 360, 30)).toBe(true); // @ 00:30
  expect(inWindow(1320, 360, 359)).toBe(true); // @ 05:59
  expect(inWindow(1320, 360, 360)).toBe(false); // @ 06:00
  expect(inWindow(1320, 360, 720)).toBe(false); // @ 12:00
});

// Disabled snooze must not discount the UI projection (no window silenced).
test("snoozeMinutes: 0 when snooze disabled", () => {
  expect(snoozeMinutes()).toBe(0);
});

// healthWindowMs: the freshness bound for the liveness heartbeat. Too tight => healthy
// pods get killed during a legitimate backoff/quota pause; too loose => a wedged poller
// isn't caught. = max(interval, 15-min quota floor, 30-min backoff cap) + 5-min grace.
test("healthWindowMs: backoff cap dominates short intervals", () => {
  expect(healthWindowMs([5])).toBe(35 * 60_000); // 30-min backoff cap + 5 grace
  expect(healthWindowMs([])).toBe(35 * 60_000); // no searches: 15-min floor still < cap
  expect(healthWindowMs([60])).toBe(65 * 60_000); // long interval dominates: 60 + 5
});

// Snooze settings validation (the API trust boundary): HH:MM parsing, tz check,
// and the empty-window guard that would otherwise mean "snooze all day".
test("hhmmToMin parses valid times and rejects junk", () => {
  expect(hhmmToMin("01:00")).toBe(60);
  expect(hhmmToMin("22:30")).toBe(1350);
  expect(hhmmToMin("00:00")).toBe(0);
  expect(hhmmToMin("24:00")).toBeNull();
  expect(hhmmToMin("7:5")).toBeNull();
  expect(hhmmToMin(90)).toBeNull();
});
test("parseSnoozeBody: valid config returns minutes", () => {
  expect(parseSnoozeBody({ enabled: true, start: "01:00", end: "07:00", tz: "America/New_York" })).toEqual({
    enabled: true,
    start: 60,
    end: 420,
    tz: "America/New_York",
  });
  // blank/absent tz -> null (server timezone)
  expect(parseSnoozeBody({ enabled: false, start: "22:00", end: "06:00", tz: "" })).toEqual({
    enabled: false,
    start: 1320,
    end: 360,
    tz: null,
  });
});
test("parseSnoozeBody: rejects bad times, equal window, bad tz", () => {
  expect(typeof parseSnoozeBody({ start: "nope", end: "07:00" })).toBe("string");
  expect(typeof parseSnoozeBody({ start: "07:00", end: "07:00" })).toBe("string"); // empty window
  expect(typeof parseSnoozeBody({ start: "01:00", end: "07:00", tz: "Mars/Phobos" })).toBe("string");
});
