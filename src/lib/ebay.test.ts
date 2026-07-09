import { expect, test } from "bun:test";
import { browseFilters, sampleMarket } from "./ebay";
import { median } from "./poller";
import type { Search } from "./types";

const base: Search = {
  id: 1,
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
  intervalMin: 5,
  enabled: true,
  seeded: false,
  createdAt: "",
};

// The eBay Browse filter contract. Mock mode bypasses this path entirely, so without a
// unit test a wrong field name (conditions vs conditionIds) 400s only in production.
test("browseFilters: buying options default to BIN, auctions when included", () => {
  expect(browseFilters(base)).toEqual(["buyingOptions:{FIXED_PRICE}"]);
  expect(browseFilters({ ...base, includeAuctions: true })).toEqual(["buyingOptions:{FIXED_PRICE|AUCTION}"]);
});

test("browseFilters: price bounds build [lo..hi], [..hi], [lo..] with a currency", () => {
  const both = browseFilters({ ...base, priceFloor: 100, priceCap: 500 });
  expect(both).toContain("price:[100..500]");
  expect(both.some((f) => f.startsWith("priceCurrency:"))).toBe(true);
  expect(browseFilters({ ...base, priceCap: 500 })).toContain("price:[..500]");
  expect(browseFilters({ ...base, priceFloor: 100 })).toContain("price:[100..]");
});

// Regression guard for the shipped bug: numeric condition IDs MUST use `conditionIds`,
// not `conditions` (which takes only NEW/USED/UNSPECIFIED enums and rejects IDs).
test("browseFilters: condition presets emit conditionIds, never conditions:{<id>}", () => {
  const neu = browseFilters({ ...base, conditions: "NEW" });
  expect(neu).toContain("conditionIds:{1000}");
  const used = browseFilters({ ...base, conditions: "USED" });
  expect(used).toContain("conditionIds:{3000|4000|5000|6000}"); // omits 7000 for-parts
  // no filter may ever put a numeric ID in the enum-only `conditions` field
  for (const f of [...neu, ...used]) expect(f.startsWith("conditions:{")).toBe(false);
  // null conditions adds no condition filter at all
  expect(browseFilters(base).some((f) => f.includes("condition"))).toBe(false);
});

test("browseFilters: all clauses compose in order", () => {
  const f = browseFilters({ ...base, includeAuctions: true, priceFloor: 50, priceCap: 900, conditions: "NEW" });
  expect(f[0]).toBe("buyingOptions:{FIXED_PRICE|AUCTION}");
  expect(f).toContain("price:[50..900]");
  expect(f).toContain("conditionIds:{1000}");
});

// The market-baseline sample reuses browseFilters with includePrice=false: it must keep
// buying-option and condition constraints but DROP the price band, or the median it stores
// would be clipped by the very band it exists to see past.
test("browseFilters: includePrice=false drops the price band, keeps other clauses", () => {
  const f = browseFilters({ ...base, priceFloor: 100, priceCap: 300, conditions: "USED" }, false);
  expect(f.some((c) => c.startsWith("price:"))).toBe(false);
  expect(f.some((c) => c.startsWith("priceCurrency:"))).toBe(false);
  expect(f).toContain("conditionIds:{3000|4000|5000|6000}");
  expect(f[0]).toBe("buyingOptions:{FIXED_PRICE}");
});

// Mock market sample must center well above a deal-hunt band so the feature is visibly
// exercisable (and the median helper agrees on the figure the poller would store).
test("sampleMarket (mock): median sits ~500, independent of the search band", async () => {
  const items = await sampleMarket({ ...base, priceFloor: 100, priceCap: 300 });
  const m = median(items.map((i) => i.price).filter((p): p is number => p != null));
  expect(m).not.toBeNull();
  expect(m!).toBeGreaterThan(300); // above the 100-300 band its own listings would sit in
  expect(m!).toBeLessThan(700);
});
