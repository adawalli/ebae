import { expect, test } from "bun:test";
import { browseFilters, conditionExcluded, marketSampleSearch, sampleMarket } from "./ebay";
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
};

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

// NOT_PARTS deliberately sends no condition filter: `conditionIds` is a whitelist with no
// negation, so the only server-side spelling of "everything but 7000" is the other 15 IDs -
// which would drop unspecified-condition listings and rot each time eBay adds an ID.
test("browseFilters: NOT_PARTS sends no condition filter (suppression is client-side)", () => {
  expect(browseFilters({ ...base, conditions: "NOT_PARTS" }).some((f) => f.includes("condition"))).toBe(false);
});

test("conditionExcluded: NOT_PARTS drops only the for-parts tier", () => {
  expect(conditionExcluded(item, "NOT_PARTS")).toBe(true);
  expect(conditionExcluded({ ...item, conditionId: "3000" }, "NOT_PARTS")).toBe(false);
  expect(conditionExcluded(item, null)).toBe(false); // "Any condition" keeps for-parts
  expect(conditionExcluded(item, "USED")).toBe(false); // eBay's conditionIds already excluded it
});

// The whole point of suppressing one ID instead of whitelisting the other 15: a listing whose
// category doesn't require a condition must still alert.
test("conditionExcluded: an unspecified conditionId is never dropped", () => {
  expect(conditionExcluded({ ...item, conditionId: null }, "NOT_PARTS")).toBe(false);
});

test("browseFilters: all clauses compose in order", () => {
  const f = browseFilters({ ...base, includeAuctions: true, priceFloor: 50, priceCap: 900, conditions: "NEW" });
  expect(f[0]).toBe("buyingOptions:{FIXED_PRICE|AUCTION}");
  expect(f).toContain("price:[50..900]");
  expect(f).toContain("conditionIds:{1000}");
});

// The market sample keeps the FLOOR and drops only the CAP. Regression guard for the
// "market ~$20 for a $150-800 doorbell" bug: dropping the whole band floods the median with
// sub-band accessories that share the query's keywords (mounts, cables, "for parts").
test("marketSampleSearch keeps the floor, drops the cap", () => {
  const m = marketSampleSearch({ ...base, priceFloor: 150, priceCap: 800, conditions: "USED" });
  expect(m.priceFloor).toBe(150);
  expect(m.priceCap).toBeNull();
  const f = browseFilters(m);
  expect(f).toContain("price:[150..]"); // floor kept, open-ended top
  expect(f.some((c) => c.includes("800"))).toBe(false); // cap gone
  expect(f).toContain("conditionIds:{3000|4000|5000|6000}"); // other constraints preserved
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
