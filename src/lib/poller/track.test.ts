import { expect, test } from "bun:test";
import {
  BIN_CHECK_DAYS,
  BONUS_MIN_GAP_MS,
  bonusEligible,
  harvest,
  inferOutcome,
  newTracked,
  soldContext,
} from "./track";
import type { TrackedItem } from "./state";
import type { Item } from "@/lib/types";

const DAY = 86400_000;
const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);

const item = (over: Partial<Item> = {}): Item => ({
  itemId: "v1|123|0",
  title: "Leica M6",
  price: 1000,
  currency: "USD",
  shippingCost: 0,
  buyingOption: "FIXED_PRICE",
  condition: "Used",
  conditionId: "3000",
  imageUrl: null,
  itemUrl: "https://www.ebay.com/itm/123",
  itemEndDate: null,
  bestOffer: false,
  ...over,
});

const tracked = (over: Partial<TrackedItem> = {}): TrackedItem => ({
  itemId: "v1|123|0",
  priceKind: "fixed",
  lastPrice: 1000,
  currency: "USD",
  itemEndDate: null,
  firstSeenAt: NOW,
  nextCheckAt: NOW + BIN_CHECK_DAYS[0] * DAY,
  checksUsed: 0,
  ...over,
});

// An auction resolves in one well-timed call: its end date comes free on the search summary,
// so the only check we ever spend lands just after the hammer falls.
test("newTracked: an auction is checked once, just after it ends", () => {
  const end = NOW + 2 * DAY;
  const t = newTracked(item({ buyingOption: "AUCTION", itemEndDate: new Date(end).toISOString() }), NOW)!;
  expect(t.priceKind).toBe("bid");
  expect(t.itemEndDate).toBe(end);
  expect(t.nextCheckAt).toBeGreaterThan(end); // a grace margin past the end, never before it
  expect(t.nextCheckAt - end).toBeLessThanOrEqual(10 * 60_000);
  expect(t.checksUsed).toBe(0);
});

// No end date means no way to know when to look, and an untimed check is a wasted call.
test("newTracked: an auction without an end date is not tracked", () => {
  expect(newTracked(item({ buyingOption: "AUCTION", itemEndDate: null }), NOW)).toBeNull();
});

test("newTracked: a fixed-price listing starts on the decay schedule", () => {
  const t = newTracked(item(), NOW)!;
  expect(t.priceKind).toBe("fixed");
  expect(t.nextCheckAt).toBe(NOW + BIN_CHECK_DAYS[0] * DAY);
  expect(t.lastPrice).toBe(1000);
});

// Best Offer listings keep showing the asking price after they sell, so what we can learn is
// a ceiling, not the realized price. Tracked, flagged, and kept out of the sold median.
test("newTracked: a Best Offer listing is flagged as a price ceiling", () => {
  expect(newTracked(item({ bestOffer: true }), NOW)!.priceKind).toBe("offer_cap");
  // an auction's winning bid IS the realized price, so the bid kind wins over the offer flag
  const auction = item({ buyingOption: "AUCTION", bestOffer: true, itemEndDate: new Date(NOW + DAY).toISOString() });
  expect(newTracked(auction, NOW)!.priceKind).toBe("bid");
});

// Re-sighting is free information: the listing is demonstrably still for sale, so the price
// refreshes and any check that came due is skipped rather than spent.
test("harvest: a re-sighting refreshes the price and defers the due check for free", () => {
  const t = tracked();
  const at = NOW + BIN_CHECK_DAYS[0] * DAY + 60_000; // just past the first scheduled check

  expect(harvest(t, item({ price: 900 }), at)).toBe(true);
  expect(t.lastPrice).toBe(900);
  expect(t.nextCheckAt).toBe(NOW + BIN_CHECK_DAYS[1] * DAY); // the next step, not now + 3d
  expect(t.checksUsed).toBe(0); // no API call was spent
});

test("harvest: an unchanged re-sighting before the next check is not a write", () => {
  const t = tracked();
  expect(harvest(t, item(), NOW + 60_000)).toBe(false);
  expect(t.nextCheckAt).toBe(NOW + BIN_CHECK_DAYS[0] * DAY);
});

test("harvest: past the last decay step the check stays due, so one call can resolve it", () => {
  const last = BIN_CHECK_DAYS[BIN_CHECK_DAYS.length - 1];
  const t = tracked({ nextCheckAt: NOW + last * DAY });
  const at = NOW + last * DAY + DAY;

  harvest(t, item(), at);

  expect(t.nextCheckAt).toBeLessThanOrEqual(at); // still due: nothing left to defer to
});

// The uniform rule, verified against the live API: a sold listing reads OUT_OF_STOCK with a
// sold quantity, and its price is the realized one (for an ended auction, the final bid).
test("inferOutcome: out of stock with a sold quantity is a sale at that price", () => {
  const out = inferOutcome(tracked(), { ok: true, availability: "OUT_OF_STOCK", soldQuantity: 1, price: 880 }, NOW);
  expect(out).toEqual({ kind: "resolved", state: "sold", soldPrice: 880 });
});

test("inferOutcome: out of stock having sold nothing is a seller-ended listing", () => {
  const out = inferOutcome(tracked(), { ok: true, availability: "OUT_OF_STOCK", soldQuantity: 0, price: 1000 }, NOW);
  expect(out).toEqual({ kind: "resolved", state: "unsold", soldPrice: null });
});

// A no-bid auction stays IN_STOCK after it ends - bidCount is null there, so availability is
// the only signal that separates "nobody bid" from "sold".
test("inferOutcome: an ended auction still in stock never sold", () => {
  const t = tracked({ priceKind: "bid", itemEndDate: NOW - 10 * 60_000 });
  const out = inferOutcome(t, { ok: true, availability: "IN_STOCK", soldQuantity: 0, price: 1000 }, NOW);
  expect(out).toEqual({ kind: "resolved", state: "unsold", soldPrice: null });
});

test("inferOutcome: a fixed-price listing still in stock walks the decay schedule", () => {
  const t = tracked({ nextCheckAt: NOW + BIN_CHECK_DAYS[0] * DAY, checksUsed: 1 });
  const at = NOW + BIN_CHECK_DAYS[0] * DAY;
  const res = { ok: true as const, availability: "IN_STOCK", soldQuantity: 0, price: 1000 };

  expect(inferOutcome(t, res, at)).toEqual({ kind: "defer", nextCheckAt: NOW + BIN_CHECK_DAYS[1] * DAY });

  // still listed after the last step: that is a positive observation that it never sold
  const late = NOW + BIN_CHECK_DAYS[BIN_CHECK_DAYS.length - 1] * DAY;
  expect(inferOutcome(t, res, late)).toEqual({ kind: "resolved", state: "unsold", soldPrice: null });
});

// Ended auctions stay readable for a while, but not forever. One retry covers a check that
// arrived a beat too late; past that the outcome is honestly unknown rather than guessed.
test("inferOutcome: a vanished auction is retried once, then given up on", () => {
  const t = tracked({ priceKind: "bid", itemEndDate: NOW - 10 * 60_000, checksUsed: 0 });
  const first = inferOutcome(t, { ok: false, errorId: 11001 }, NOW);
  expect(first.kind).toBe("defer");
  expect((first as { nextCheckAt: number }).nextCheckAt).toBeGreaterThan(NOW);

  const retried = tracked({ priceKind: "bid", itemEndDate: NOW - 10 * 60_000, checksUsed: 1 });
  expect(inferOutcome(retried, { ok: false, errorId: 11001 }, NOW)).toEqual({
    kind: "resolved",
    state: "unknown",
    soldPrice: null,
  });
});

// A fixed-price listing that has vanished may well have sold, but eBay no longer says at what
// price - recording a guess would poison the median it feeds.
test("inferOutcome: a vanished fixed-price listing is unknown, not a sale", () => {
  expect(inferOutcome(tracked(), { ok: false, errorId: 11004 }, NOW)).toEqual({
    kind: "resolved",
    state: "unknown",
    soldPrice: null,
  });
});

// Surplus quota buys checks the schedule hasn't asked for yet. What it may buy them on is
// narrow: a fixed-price listing that isn't due, not looked at inside BONUS_MIN_GAP_MS, and whose
// answer means the same thing early as it would on schedule.
test("bonusEligible: only not-yet-due fixed-price follows, worst gap first", () => {
  const soon = tracked({ itemId: "soon", nextCheckAt: NOW + DAY });
  const late = tracked({ itemId: "late", nextCheckAt: NOW + 20 * DAY });
  // Best Offer sells below its asking price, so resolve() discards the figure it reads back.
  // Spending a surplus check on one buys a price that is thrown away, and displaces a fixed
  // listing from the same slice.
  const cap = tracked({ itemId: "cap", priceKind: "offer_cap", nextCheckAt: NOW + 5 * DAY });
  // An auction before its end reads IN_STOCK, which inferOutcome resolves as "nobody bid" -
  // true only after the hammer falls. Checking one early would book a false outcome.
  const auction = tracked({ itemId: "auction", priceKind: "bid", nextCheckAt: NOW + 2 * DAY });
  const due = tracked({ itemId: "due", nextCheckAt: NOW - 1000 }); // the scheduled path owns this
  const justChecked = tracked({ itemId: "justChecked", nextCheckAt: NOW + 30 * DAY });

  const picks = bonusEligible(
    [soon, late, cap, auction, due, justChecked],
    new Map([["justChecked", NOW - BONUS_MIN_GAP_MS + 1]]),
    NOW,
  );

  // Furthest-out first: those are the listings with the longest stretch in which they could sell
  // and then stop being readable, which is exactly the price this feature exists to save.
  // `justChecked` is furthest of all and still excluded, so the gap dropped it, not the ordering.
  expect(picks.map((t) => t.itemId)).toEqual(["late", "soon"]);
});

// Breadth before depth: a listing gets a second look only once every other listing has had one.
// Without this the furthest-out follow would take every check the surplus can buy.
test("bonusEligible: least recently checked first, gap breaks the tie", () => {
  const far = tracked({ itemId: "far", nextCheckAt: NOW + 20 * DAY });
  const near = tracked({ itemId: "near", nextCheckAt: NOW + DAY });
  const fresh = tracked({ itemId: "fresh", nextCheckAt: NOW + 2 * DAY });

  // `far` is exactly at the gap, so it is eligible again - just behind the two never looked at.
  const picks = bonusEligible([far, near, fresh], new Map([["far", NOW - BONUS_MIN_GAP_MS]]), NOW);

  expect(picks.map((t) => t.itemId)).toEqual(["fresh", "near", "far"]);
});

test("bonusEligible: nothing to do is an empty list, not a throw", () => {
  expect(bonusEligible([], new Map(), NOW)).toEqual([]);
  expect(bonusEligible([tracked({ nextCheckAt: NOW - 1 })], new Map(), NOW)).toEqual([]);
});

// The gate on the whole feature: too few or too stale realized prices must read as "no
// context" rather than as a confident median built from one lucky sale.
test("soldContext: needs a real sample inside the recency window", () => {
  const at = (days: number) => NOW - days * DAY;
  expect(soldContext([{ price: 100, atMs: at(1) }], NOW)).toBeNull();
  expect(soldContext([], NOW)).toBeNull();

  const fresh = [
    { price: 100, atMs: at(1) },
    { price: 200, atMs: at(2) },
    { price: 300, atMs: at(3) },
  ];
  expect(soldContext(fresh, NOW)).toEqual({ typical: 200, count: 3 });

  // one stale price drops the sample back under the threshold instead of skewing it
  expect(soldContext([...fresh.slice(0, 2), { price: 300, atMs: at(400) }], NOW)).toBeNull();
});
