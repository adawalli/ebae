import { expect, test } from "bun:test";
import { browseFilters } from "./ebay";
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
