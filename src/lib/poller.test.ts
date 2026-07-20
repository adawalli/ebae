import { expect, test } from "bun:test";
import {
  BONUS_HEADROOM,
  GOV_MAX_FACTOR,
  GOV_MIN_SPEND,
  MAX_BACKOFF_MS,
  QUOTA_SKIP_MS,
  activeFracElapsed,
  baselineInvalidated,
  bonusBudget,
  excludeMatch,
  governedDelayMs,
  governorDecision,
  governorFactor,
  healthWindowMs,
  inWindow,
  matchCriteriaChanged,
  median,
  mergeCalls,
  snoozeMinutes,
  surplusFrac,
  usedToday,
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
  // trackSold decides what we check up on afterwards, not what the search matches or
  // what the baseline sample covers: turning it on must cost neither the seen set nor
  // the market median.
  expect(matchCriteriaChanged(cur, { trackSold: true })).toBe(false);
  expect(baselineInvalidated(curEx, { trackSold: true })).toBe(false);
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
  conditionId: null,
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

// Sold basis: what listings actually realized, which beats any asking-price baseline. Labeled
// so the reader knows which question the number answers, and sample-gated like "recent" - the
// count here is real sales, and three of them is the difference between a going rate and an
// anecdote.
test("dealField: sold basis labels 'Sold' and is sample-gated", () => {
  expect(dealField(mkItem(250), { typical: 500, count: 4, basis: "sold" })).toEqual({
    name: "Sold",
    value: "$500.00 · ▼ 50% under",
    inline: true,
  });
  expect(dealField(mkItem(250), { typical: 500, count: 2, basis: "sold" })).toBeNull();
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
  expect((parseSearchBody({ conditions: "NOT_PARTS" }, true) as Record<string, unknown>).conditions).toBe("NOT_PARTS");
  expect(typeof parseSearchBody({ q: "x", conditions: "1000|3000" }, false)).toBe("string"); // injection rejected
  expect((parseSearchBody({ conditions: "" }, true) as Record<string, unknown>).conditions).toBeNull();
  expect(parseSearchBody({ excludeTerms: '13" display' }, true)).toBe("excludeTerms cannot contain double quotes");
  expect((parseSearchBody({ excludeTerms: "   " }, true) as Record<string, unknown>).excludeTerms).toBeNull();
  expect((parseSearchBody({ excludeTerms: ",," }, true) as Record<string, unknown>).excludeTerms).toBeNull(); // no real term
  const long = parseSearchBody({ excludeTerms: "a".repeat(999) }, true) as Record<string, unknown>;
  expect((long.excludeTerms as string).length).toBe(500);
});

// Sold tracking is on by default, while a partial update must leave the stored choice alone.
test("parseSearchBody: trackSold defaults on and is untouched by a partial patch", () => {
  expect((parseSearchBody({ q: "x" }, false) as Record<string, unknown>).trackSold).toBe(true);
  expect((parseSearchBody({ q: "x", trackSold: true }, false) as Record<string, unknown>).trackSold).toBe(true);
  expect((parseSearchBody({ q: "x", trackSold: false }, false) as Record<string, unknown>).trackSold).toBe(false);
  expect((parseSearchBody({ trackSold: 1 }, true) as Record<string, unknown>).trackSold).toBe(true); // coerced
  expect((parseSearchBody({ trackSold: false }, true) as Record<string, unknown>).trackSold).toBe(false);
  expect((parseSearchBody({ q: "x" }, true) as Record<string, unknown>).trackSold).toBeUndefined();
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

// Feeds the UI's "silenced per day" projection: a disabled snooze must discount nothing, and
// an enabled one reports its true length even when the window crosses midnight.
test("snoozeMinutes: 0 when disabled, window length when enabled", () => {
  expect(snoozeMinutes({ enabled: false, start: 60, end: 420, tz: null })).toBe(0);
  expect(snoozeMinutes({ enabled: true, start: 60, end: 420, tz: null })).toBe(360); // 01:00-07:00
  expect(snoozeMinutes({ enabled: true, start: 1320, end: 360, tz: null })).toBe(480); // 22:00-06:00
});

// ---------- budget governor ----------
// The governor stretches poll intervals when a user's spend is on track to exhaust the daily
// eBay budget before the day ends. Slow-down only: the factor is >= 1 by construction, so a
// search can never poll faster than the interval its owner set.

// The guarantee the whole feature rests on: a user whose spend is on track to land exactly on
// the ceiling at the end of the day is using their budget perfectly, and is never slowed. This
// is why the signal is the projected shortfall and not raw used/ceiling - the latter would
// throttle everyone every evening for being 90% through a budget they are entitled to spend.
test("governorFactor leaves an on-budget user alone all day", () => {
  // Exactly on track at every point in the day: f of the budget spent, f of the day gone.
  for (const f of [0.1, 0.25, 0.5, 0.75, 0.99]) {
    expect(governorFactor(5000 * f, 5000, f)).toBe(1);
  }
  expect(governorFactor(1000, 5000, 0.5)).toBe(1); // well under: 20% spent at midday
  expect(governorFactor(4000, 5000, 0.9)).toBe(1); // 80% spent with 10% of the day left
});

// Engaged, the factor is the exact correction: the rest of the day would naturally cost
// `naturalSpendLeft`, only `budgetLeft` remains, so slow by their ratio and the spend lands on
// the ceiling instead of hitting the cliff early.
test("governorFactor slows by exactly the projected shortfall", () => {
  // Midday, 3000 of 5000 spent: the afternoon would cost another 3000 but only 2000 is left.
  expect(governorFactor(3000, 5000, 0.5)).toBe(1.5);
  // Midday, 2600 spent: afternoon costs 2600, 2400 left. Quantized to 3 decimals.
  expect(governorFactor(2600, 5000, 0.5)).toBe(1.083);
});

test("governor releases when the current configuration fits the remaining budget", () => {
  // 2,300 calls are spent one-quarter through the active day, but the new configuration needs
  // only 2,250 more calls. That is safely within the 2,700 calls left, so polling resets now.
  expect(governorDecision(2300, 5000, 0.25, 3000, true)).toEqual({ active: false, factor: 1 });
});

test("governor holds a five-percent release buffer", () => {
  // The current configuration fits, but with only 2% headroom. An engaged governor must keep
  // a 5% slowdown until the configured work fits with the full 5% release margin.
  expect(governorDecision(2300, 5000, 0.25, 3528, true)).toEqual({ active: true, factor: 1.05 });
});

test("governorFactor never exceeds the cap", () => {
  expect(governorFactor(4900, 5000, 0.5)).toBe(GOV_MAX_FACTOR); // 49x correction, capped
  expect(governorFactor(5000, 5000, 0.5)).toBe(GOV_MAX_FACTOR); // budget gone at midday
  expect(governorFactor(9999, 5000, 0.5)).toBe(GOV_MAX_FACTOR); // overspent past the ceiling
});

test("governorFactor is monotonic in spend", () => {
  let prev = 0;
  for (let used = 0; used <= 6000; used += 100) {
    const f = governorFactor(used, 5000, 0.5);
    expect(f).toBeGreaterThanOrEqual(prev);
    expect(f).toBeGreaterThanOrEqual(1);
    expect(f).toBeLessThanOrEqual(GOV_MAX_FACTOR);
    prev = f;
  }
});

// Just after the local midnight reset, activeFrac is near zero, so used/(ceiling*activeFrac)
// spikes on a handful of calls and would slam every search to 4x for no reason. Below a floor
// of total spend the governor stays inert.
test("governorFactor is inert on a trickle of spend after midnight", () => {
  expect(governorFactor(20, 5000, 0.001)).toBe(1); // 20 calls at 00:01: pace is meaningless
  expect(governorFactor(GOV_MIN_SPEND * 5000 - 1, 5000, 0.001)).toBe(1); // just under the floor
  expect(governorFactor(GOV_MIN_SPEND * 5000, 5000, 0.001)).toBeGreaterThan(1); // at it, pace rules
});

test("governorFactor guards degenerate inputs", () => {
  expect(governorFactor(5000, 5000, 0)).toBe(1); // no active minutes elapsed yet
  expect(governorFactor(5000, 5000, -1)).toBe(1);
  expect(governorFactor(5000, 0, 0.5)).toBe(1); // ceiling unset/zero: nothing to protect
  expect(governorFactor(0, 5000, 0.5)).toBe(1);
});

// The one guarantee the feature rests on: the governed delay is never shorter than the
// interval the user asked for, at any factor the governor can produce.
test("usedToday reads a counter only on the day it was counted", () => {
  expect(usedToday({ date: "Fri Jul 17 2026", used: 4500 }, "Fri Jul 17 2026")).toBe(4500);
  // The counter is not cleared at midnight - the next poll rolls it over - so every reader that
  // isn't that poll has to treat a stale date as no spend rather than as a full day of it.
  expect(usedToday({ date: "Thu Jul 16 2026", used: 4500 }, "Fri Jul 17 2026")).toBe(0);
});

// Budget that isn't spent by local midnight expires worthless, so a user whose saved
// configuration doesn't need it all can afford extra sold checks. bonusBudget is how much of
// that surplus is available right now - the two bounds below are the whole feature.
test("bonusBudget stays out of what the saved configuration still needs", () => {
  // Midday, 100 spent, a config that costs 1000/day. The afternoon needs 500, the 5% headroom
  // is 250, so 4150 of the ceiling is genuinely spare - but pace caps it at half the day's
  // spendable budget: floor(0.5 * 4750) - 100.
  expect(bonusBudget(100, 5000, 0.5, 1000)).toBe(2275);
  // An over-configured day: the reserve (3000) is now the binding bound, not the pace.
  expect(bonusBudget(100, 5000, 0.5, 6000)).toBe(1650);
});

// "Use the budget throughout the day" - surplus trickles out in proportion to the elapsed
// pollable day rather than being dumped the moment it's identified.
test("bonusBudget paces the surplus across the day", () => {
  expect(bonusBudget(0, 5000, 0, 1000)).toBe(0); // just after midnight: nothing is surplus yet
  expect(bonusBudget(2500, 5000, 0.5, 1000)).toBe(0); // already at pace: no more today
  // Monotonic in elapsed day, at a fixed spend.
  let prev = -1;
  for (const f of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const b = bonusBudget(100, 5000, f, 1000);
    expect(b).toBeGreaterThanOrEqual(prev);
    prev = b;
  }
  expect(bonusBudget(100, 5000, 1, 1000)).toBe(4650); // end of day: everything but the headroom
});

// The guarantee that makes this safe to turn on: spending the entire bonus budget must never
// make the governor slow the user's polls. That is what the reserve + headroom buy.
test("bonusBudget never spends the governor into engaging", () => {
  for (const frac of [0.1, 0.25, 0.5, 0.75, 0.99]) {
    for (const projected of [0, 500, 1000, 3000, 6000]) {
      for (const used of [0, 100, 1000, 2500, 4000]) {
        const bonus = bonusBudget(used, 5000, frac, projected);
        const spent = used + bonus;
        // Spending it all leaves the factor exactly where it was: the surplus is only ever what
        // the configuration doesn't need. A user the governor is already slowing gets no bonus
        // at all, so the two factors agree there too.
        expect(governorFactor(spent, 5000, frac, projected)).toBe(governorFactor(used, 5000, frac, projected));
        if (bonus > 0) {
          expect(governorFactor(spent, 5000, frac, projected)).toBe(1);
          expect(spent).toBeLessThanOrEqual(5000 - Math.ceil(BONUS_HEADROOM * 5000));
        }
      }
    }
  }
});

// The daily counter rolls on the server's calendar day, but activeFrac is measured in the user's
// own zone. A user 14 hours ahead would read as most of the way through their day at the instant
// their budget resets, and the pace bound would release the whole surplus in the first hour.
test("surplusFrac paces against the day the counter actually rolls on", () => {
  const at = (h: number, m = 0) => new Date(2026, 6, 19, h, m, 0);
  expect(surplusFrac(0.58, at(0))).toBe(0); // their afternoon, the server's midnight: nothing yet
  expect(surplusFrac(0.58, at(6))).toBe(0.25); // still the server's morning
  expect(surplusFrac(0.25, at(18))).toBe(0.25); // behind the server: their own clock still rules
  expect(surplusFrac(0.5, at(12))).toBe(0.5); // same zone: unchanged
});

test("bonusBudget guards degenerate inputs", () => {
  expect(bonusBudget(0, 0, 0.5, 1000)).toBe(0); // ceiling unset
  expect(bonusBudget(0, 5000, -1, 1000)).toBe(0);
  expect(bonusBudget(9999, 5000, 0.5, 1000)).toBe(0); // already overspent
});

test("governedDelayMs never polls faster than the user's interval", () => {
  for (const interval of [1, 5, 15, 60, 1440]) {
    for (const used of [0, 100, 2500, 4000, 5000, 99_999]) {
      const factor = governorFactor(used, 5000, 0.5);
      expect(governedDelayMs(interval, factor)).toBeGreaterThanOrEqual(interval * 60_000);
      expect(governedDelayMs(interval, factor)).toBeLessThanOrEqual(interval * 60_000 * GOV_MAX_FACTOR);
    }
  }
});

// activeFracElapsed: how much of the day's pollable time is gone. Snooze-aware, because a
// user snoozing 22:00-06:00 has 960 pollable minutes, not 1440 - measuring against wall-clock
// would read them as behind pace all morning and never throttle.
test("activeFracElapsed tracks wall clock when snooze is off", () => {
  const off = { enabled: false, start: 60, end: 420, tz: null };
  expect(activeFracElapsed(off, 0)).toBe(0);
  expect(activeFracElapsed(off, 720)).toBeCloseTo(0.5, 5);
  expect(activeFracElapsed(off, 1440)).toBe(1);
});

test("activeFracElapsed ignores snoozed minutes", () => {
  const sn = { enabled: true, start: 60, end: 420, tz: null }; // 01:00-07:00, 1080 active min
  expect(activeFracElapsed(sn, 60)).toBeCloseTo(60 / 1080, 5); // 01:00: 60 active min gone
  expect(activeFracElapsed(sn, 420)).toBeCloseTo(60 / 1080, 5); // 07:00: snooze added nothing
  expect(activeFracElapsed(sn, 240)).toBeCloseTo(60 / 1080, 5); // mid-snooze: frozen
  expect(activeFracElapsed(sn, 1440)).toBe(1);
});

test("activeFracElapsed handles a window crossing midnight", () => {
  const sn = { enabled: true, start: 1320, end: 360, tz: null }; // 22:00-06:00, 960 active min
  expect(activeFracElapsed(sn, 360)).toBe(0); // 06:00: the whole night was snoozed
  expect(activeFracElapsed(sn, 720)).toBeCloseTo(360 / 960, 5); // noon: 6 active hours in
  expect(activeFracElapsed(sn, 1320)).toBe(1); // 22:00: every active minute is spent
  expect(activeFracElapsed(sn, 1439)).toBe(1); // deep in the window: stays clamped
});

// healthWindowMs: the freshness bound for the liveness heartbeat. Too tight => healthy
// pods get killed during a legitimate backoff/quota pause; too loose => a wedged poller
// isn't caught. = max(interval, 15-min quota floor, 30-min backoff cap) + 5-min grace.
test("healthWindowMs: backoff cap dominates short intervals", () => {
  expect(healthWindowMs([5])).toBe(35 * 60_000); // 30-min backoff cap + 5 grace
  expect(healthWindowMs([])).toBe(35 * 60_000); // no searches: 15-min floor still < cap
  expect(healthWindowMs([60])).toBe(245 * 60_000); // governed interval dominates: 60 * 4 + 5
});

// The window has to outlast every delay schedule() can be handed, or a poller that is merely
// idling on purpose reads as wedged and /api/health 503s a healthy pod. The delays live in
// loop.ts; this asserts the relationship rather than the arithmetic, so raising one of them
// without widening the window fails here instead of in production.
test("healthWindowMs outlasts every reschedule delay", () => {
  for (const intervals of [[], [1], [5, 1440], [60]]) {
    const window = healthWindowMs(intervals);
    expect(window).toBeGreaterThan(QUOTA_SKIP_MS);
    expect(window).toBeGreaterThan(MAX_BACKOFF_MS);
    for (const m of intervals) {
      expect(window).toBeGreaterThan(m * 60_000);
      expect(window).toBeGreaterThan(governedDelayMs(m, GOV_MAX_FACTOR));
    }
  }
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
