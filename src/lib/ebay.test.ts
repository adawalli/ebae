import { expect, test } from "bun:test";
import {
  browseFilters,
  checkItem,
  conditionExcluded,
  currencyFor,
  marketSampleSearch,
  mockCheckItem,
  mockMarket,
  type EbayCreds,
} from "./ebay";
import { median } from "./poller";
import type { Item, Search } from "./types";

const item: Item = {
  itemId: "v1|1|0",
  title: "Sonos Era 300",
  price: 179.95,
  currency: "USD",
  shippingCost: 0,
  buyingOption: "FIXED_PRICE",
  condition: "Parts Only",
  conditionId: "7000",
  imageUrl: null,
  itemUrl: "https://www.ebay.com/itm/1",
  itemEndDate: null,
  bestOffer: false,
};

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

// The mock has to resolve as a sale, or a dev without eBay keys never sees a sold median form.
test("mockCheckItem: resolves sold, just under the last seen price", () => {
  expect(mockCheckItem(100)).toEqual({ ok: true, availability: "OUT_OF_STOCK", soldQuantity: 1, price: 90 });
  expect(mockCheckItem(null).price).toBeNull();
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
