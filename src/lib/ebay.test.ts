import { expect, test } from "bun:test";
import {
  RATE_LIMIT_DEFAULT_MS,
  RateLimitError,
  browseFilters,
  checkItem,
  conditionExcluded,
  currencyFor,
  marketSampleSearch,
  mockCheckItem,
  mockMarket,
  mockSearch,
  retryAfterMs,
  searchNewlyListed,
  type EbayCreds,
} from "./ebay";
import { median } from "./poller";
import { mkItem } from "@/__tests__/helpers/fixtures";
import type { Item, Search } from "./types";

const item: Item = mkItem({ condition: "Parts Only", conditionId: "7000" });

const base: Search = {
  id: 1,
  userId: 1,
  q: "Leica M6",
  categoryId: null,
  priceFloor: null,
  priceCap: null,
  binOnly: true,
  includeAuctions: false,
  conditions: null,
  excludeTerms: null,
  marketMedian: null,
  marketSampledAt: null,
  trackSold: false,
  intervalMin: 5,
  enabled: true,
  seeded: false,
  createdAt: "",
};

// The currency the price filter is denominated in follows the user's marketplace, so a GB
// user's price band isn't quietly compared against USD.
test("currencyFor: maps known marketplaces, falls back to USD", () => {
  expect(currencyFor("EBAY_GB")).toBe("GBP");
  expect(currencyFor("EBAY_DE")).toBe("EUR");
  expect(currencyFor("EBAY_US")).toBe("USD");
  expect(currencyFor("EBAY_NOPE")).toBe("USD");
});

// The eBay Browse filter contract. Mock mode bypasses this path entirely, so without a
// unit test a wrong field name (conditions vs conditionIds) 400s only in production.
test("browseFilters: buying options default to BIN, auctions when included", () => {
  expect(browseFilters(base, "USD")).toEqual(["buyingOptions:{FIXED_PRICE}"]);
  expect(browseFilters({ ...base, includeAuctions: true }, "USD")).toEqual(["buyingOptions:{FIXED_PRICE|AUCTION}"]);
});

// Sold tracking widens the query to auctions even on a BIN-only search, so their winning bids
// can feed the sold median (the poller follows them without alerting - see loop.ts). Without
// this the "real value" of a BIN-only search would never reflect what auctions actually close at.
test("browseFilters: trackSold widens to auctions on a BIN-only search", () => {
  expect(browseFilters({ ...base, trackSold: true }, "USD")).toEqual(["buyingOptions:{FIXED_PRICE|AUCTION}"]);
  // neither flag set: stays BIN-only
  expect(browseFilters({ ...base, trackSold: false, includeAuctions: false }, "USD")).toEqual([
    "buyingOptions:{FIXED_PRICE}",
  ]);
});

test("browseFilters: price bounds build [lo..hi], [..hi], [lo..] with a currency", () => {
  const both = browseFilters({ ...base, priceFloor: 100, priceCap: 500 }, "USD");
  expect(both).toContain("price:[100..500]");
  expect(both.some((f) => f.startsWith("priceCurrency:"))).toBe(true);
  expect(browseFilters({ ...base, priceCap: 500 }, "USD")).toContain("price:[..500]");
  expect(browseFilters({ ...base, priceFloor: 100 }, "USD")).toContain("price:[100..]");
});

// The currency clause comes from the caller's marketplace, not a module-global.
test("browseFilters: priceCurrency follows the passed currency", () => {
  expect(browseFilters({ ...base, priceFloor: 100 }, "GBP")).toContain("priceCurrency:GBP");
});

// No preset may send a condition clause: `conditionIds` is a keep-list with no negation, so it
// drops every listing whose category states no condition, and rots as eBay adds IDs. Every
// preset is enforced by conditionExcluded instead. (Supersedes the old guard against putting
// numeric IDs in the enum-only `conditions` field - we now send neither.)
test("browseFilters: no preset emits a condition clause", () => {
  for (const c of [null, "NOT_PARTS", "NEW", "USED"]) {
    expect(browseFilters({ ...base, conditions: c }, "USD").some((f) => f.includes("condition"))).toBe(false);
  }
});

const withId = (conditionId: string | null) => ({ ...item, conditionId });

test("conditionExcluded: NOT_PARTS drops only the for-parts tier", () => {
  expect(conditionExcluded(withId("7000"), "NOT_PARTS")).toBe(true);
  expect(conditionExcluded(withId("3000"), "NOT_PARTS")).toBe(false);
  expect(conditionExcluded(withId("2000"), "NOT_PARTS")).toBe(false); // refurb is not junk
  expect(conditionExcluded(withId("7000"), null)).toBe(false); // "Any condition" keeps for-parts
});

// USED is a drop-list (parts + the new family), so the tiers the old keep-list silently lost -
// refurb, Like New, and the apparel pre-owned grades - now reach the user.
test("conditionExcluded: USED drops parts and new, keeps every used-family tier", () => {
  for (const id of ["7000", "1000", "1500", "1750"]) expect(conditionExcluded(withId(id), "USED")).toBe(true);
  for (const id of ["2000", "2010", "2020", "2030", "2500", "2750", "2990", "3000", "3010", "4000", "5000", "6000"])
    expect(conditionExcluded(withId(id), "USED")).toBe(false);
});

test("conditionExcluded: NEW keeps the new family, drops the rest", () => {
  for (const id of ["1000", "1500", "1750"]) expect(conditionExcluded(withId(id), "NEW")).toBe(false);
  for (const id of ["2750", "3000", "7000"]) expect(conditionExcluded(withId(id), "NEW")).toBe(true);
});

// The whole point of a drop-list: a listing whose category states no condition must survive
// every preset. A conditionIds keep-list could never express this.
test("conditionExcluded: an unspecified conditionId is never dropped", () => {
  for (const c of [null, "NOT_PARTS", "NEW", "USED"]) expect(conditionExcluded(withId(null), c)).toBe(false);
});

// An ID eBay adds tomorrow must reach the user, not vanish. This is the rot a keep-list has.
test("conditionExcluded: an unknown future condition ID survives NOT_PARTS and USED", () => {
  expect(conditionExcluded(withId("8000"), "NOT_PARTS")).toBe(false);
  expect(conditionExcluded(withId("8000"), "USED")).toBe(false);
});

test("browseFilters: all clauses compose in order", () => {
  const f = browseFilters({ ...base, includeAuctions: true, priceFloor: 50, priceCap: 900, conditions: "NEW" }, "USD");
  expect(f[0]).toBe("buyingOptions:{FIXED_PRICE|AUCTION}");
  expect(f).toContain("price:[50..900]");
});

// The market sample keeps the FLOOR and drops only the CAP. Regression guard for the
// "market ~$20 for a $150-800 doorbell" bug: dropping the whole band floods the median with
// sub-band accessories that share the query's keywords (mounts, cables, "for parts").
test("marketSampleSearch keeps the floor, drops the cap", () => {
  const m = marketSampleSearch({ ...base, priceFloor: 150, priceCap: 800, conditions: "USED" });
  expect(m.priceFloor).toBe(150);
  expect(m.priceCap).toBeNull();
  const f = browseFilters(m, "USD");
  expect(f).toContain("price:[150..]"); // floor kept, open-ended top
  expect(f.some((c) => c.includes("800"))).toBe(false); // cap gone
  expect(m.conditions).toBe("USED"); // other constraints preserved (applied via conditionExcluded)
});

// The market sample measures asking prices, so BOTH auction levers are cleared before it builds
// the query - trackSold widens the poll and includeAuctions is the user's opt-in, but an auction
// summary's price is a running bid, not an asking price, so neither belongs in the median.
test("marketSampleSearch clears both auction levers so the sample stays FIXED_PRICE-only", () => {
  const fromTrack = marketSampleSearch({ ...base, trackSold: true });
  expect(fromTrack.trackSold).toBe(false);
  expect(browseFilters(fromTrack, "USD")).toEqual(["buyingOptions:{FIXED_PRICE}"]);
  const fromInclude = marketSampleSearch({ ...base, includeAuctions: true });
  expect(fromInclude.includeAuctions).toBe(false);
  expect(browseFilters(fromInclude, "USD")).toEqual(["buyingOptions:{FIXED_PRICE}"]);
});

// The mock market sample must apply the same condition filter as the mock search: they call
// the same helper, and passing it the display string instead of the ID silently empties the
// sample (no display name matches a numeric ID), storing a null baseline. Both fields are
// string | null, so only a test catches the mix-up.
test("mockMarket: the condition preset filters the sample by ID", () => {
  const neu = mockMarket({ ...base, conditions: "NEW" });
  expect(neu.length).toBeGreaterThan(0);
  // new family, plus unspecified-condition listings, which no preset may drop
  expect(neu.every((i) => i.conditionId == null || ["1000", "1500", "1750"].includes(i.conditionId!))).toBe(true);
  const notParts = mockMarket({ ...base, conditions: "NOT_PARTS" });
  expect(notParts.length).toBeGreaterThan(0);
  expect(notParts.every((i) => i.conditionId !== "7000")).toBe(true); // junk can't drag the median
});

// checkItem is the whole sold-price feature's read path and mock mode never exercises it, so
// the request shape and the three response classes are pinned here. A wrong fieldgroup or an
// unescaped item id (the stored ids are "v1|123|0" - the pipes MUST be percent-encoded) only
// shows up as a 400 against the live API.
function stubEbay(handler: (url: string) => Response): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/identity/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 7200 });
    return handler(url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const creds = (userId: number): EbayCreds => ({
  userId,
  clientId: "id",
  clientSecret: "secret",
  env: "production",
  marketplace: "EBAY_US",
});

test("checkItem: a sold listing reads back its availability, sold quantity and price", async () => {
  let asked = "";
  const restore = stubEbay((url) => {
    asked = url;
    return Response.json({
      price: { value: "162.50", currency: "USD" },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "OUT_OF_STOCK", estimatedSoldQuantity: 1 }],
    });
  });
  try {
    expect(await checkItem(creds(901), "v1|123|0")).toEqual({
      ok: true,
      price: 162.5,
      availability: "OUT_OF_STOCK",
      soldQuantity: 1,
    });
  } finally {
    restore();
  }
  expect(asked).toContain("/buy/browse/v1/item/v1%7C123%7C0");
  expect(asked).toContain("fieldgroups=COMPACT");
});

// A listing eBay has dropped is an answer, not a failure: the caller resolves it rather than
// retrying forever.
test("checkItem: the gone errors report not-ok instead of throwing", async () => {
  const restore = stubEbay(() => Response.json({ errors: [{ errorId: 11001 }] }, { status: 404 }));
  try {
    expect(await checkItem(creds(902), "v1|123|0")).toEqual({ ok: false, errorId: 11001 });
  } finally {
    restore();
  }
});

// Anything else (auth, rate limit, an outage) must NOT read as an ended listing, or a bad hour
// would resolve every followed item as unknown and throw the tracking away.
test("checkItem: other failures throw", async () => {
  const restore = stubEbay(() => Response.json({ errors: [{ errorId: 2001 }] }, { status: 500 }));
  try {
    await expect(checkItem(creds(903), "v1|123|0")).rejects.toThrow(/item check failed/);
  } finally {
    restore();
  }
});

// Retry-After is either delay-seconds or an HTTP-date (RFC 9110); anything else -> null so the
// caller falls back to a default. The rate-limit signal is what lets the poll loop reschedule off
// eBay's own hint instead of a blind, compounding backoff.
test("retryAfterMs: parses delay-seconds and an HTTP-date, null when absent or junk", () => {
  const res = (h: Record<string, string>) => new Response("", { headers: h });
  expect(retryAfterMs(res({ "retry-after": "120" }))).toBe(120_000);
  expect(retryAfterMs(res({}))).toBeNull();
  expect(retryAfterMs(res({ "retry-after": "not-a-date" }))).toBeNull();
  const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  expect(retryAfterMs(res({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), at - 30_000)).toBe(30_000);
});

// A 429 on the search path must surface as a typed RateLimitError carrying the wait, so the loop
// honors it rather than mistaking it for a generic outage and compounding its backoff.
test("searchNewlyListed: a 429 with Retry-After throws RateLimitError with the parsed wait", async () => {
  const restore = stubEbay(() =>
    Response.json({ errors: [{ errorId: 70001 }] }, { status: 429, headers: { "retry-after": "90" } }),
  );
  try {
    const err = await searchNewlyListed(creds(910), base).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(90_000);
  } finally {
    restore();
  }
});

test("searchNewlyListed: a 429 without Retry-After falls back to the default wait", async () => {
  const restore = stubEbay(() => Response.json({ errors: [{ errorId: 70001 }] }, { status: 429 }));
  try {
    const err = await searchNewlyListed(creds(911), base).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(RATE_LIMIT_DEFAULT_MS);
  } finally {
    restore();
  }
});

// A non-429 search failure is still a plain Error (the loop backs off), not a rate-limit signal.
test("searchNewlyListed: a 500 stays a generic error, not a RateLimitError", async () => {
  const restore = stubEbay(() => Response.json({ errors: [{ errorId: 500 }] }, { status: 500 }));
  try {
    const err = await searchNewlyListed(creds(912), base).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RateLimitError);
  } finally {
    restore();
  }
});

// The mock has to resolve as a sale, or a dev without eBay keys never sees a sold median form.
test("mockCheckItem: resolves sold, just under the last seen price", () => {
  expect(mockCheckItem(100)).toEqual({ ok: true, availability: "OUT_OF_STOCK", soldQuantity: 1, price: 90 });
  expect(mockCheckItem(null).price).toBeNull();
});

// A dev without eBay keys must be able to exercise the auction-sold path: a BIN-only tracking
// search has to surface some auctions (with an end date, or newTracked declines them), while a
// plain BIN-only search still surfaces none.
test("mockSearch: a BIN-only tracking search surfaces datable auctions, a plain one none", () => {
  const auctions = mockSearch({ ...base, id: 8801, trackSold: true }).filter((i) => i.buyingOption === "AUCTION");
  expect(auctions.length).toBeGreaterThan(0);
  expect(auctions.every((a) => a.itemEndDate != null)).toBe(true);
  expect(mockSearch({ ...base, id: 8802 }).every((i) => i.buyingOption === "FIXED_PRICE")).toBe(true);
});

// mockMarket must mirror the live sample, which is FIXED_PRICE-only: neither trackSold nor
// includeAuctions may leak auction-typed listings into the mock asking-price sample, or mock and
// live would disagree on which listing types the baseline is drawn from.
test("mockMarket: no auctions leak in even with trackSold or includeAuctions set", () => {
  expect(mockMarket({ ...base, trackSold: true }).every((i) => i.buyingOption === "FIXED_PRICE")).toBe(true);
  expect(mockMarket({ ...base, includeAuctions: true }).every((i) => i.buyingOption === "FIXED_PRICE")).toBe(true);
});

// Mock market sample must center well above a deal-hunt band so the feature is visibly
// exercisable (and the median helper agrees on the figure the poller would store).
test("mockMarket: median sits ~500, independent of the search band", () => {
  const items = mockMarket({ ...base, priceFloor: 100, priceCap: 300 });
  const m = median(items.map((i) => i.price).filter((p): p is number => p != null));
  expect(m).not.toBeNull();
  expect(m!).toBeGreaterThan(300); // above the 100-300 band its own listings would sit in
  expect(m!).toBeLessThan(700);
});
