import { expect, test } from "bun:test";
import { ebayWebUrl } from "./utils";

const base = { q: "mac mini m4 -parts", categoryId: null, priceFloor: null, priceCap: null, includeAuctions: false };

test("BIN-only, newest-first, all categories on ebay.com", () => {
  const u = new URL(ebayWebUrl(base));
  expect(u.host).toBe("www.ebay.com");
  expect(u.searchParams.get("_nkw")).toBe("mac mini m4 -parts");
  expect(u.searchParams.get("_sacat")).toBe("0");
  expect(u.searchParams.get("_sop")).toBe("10");
  expect(u.searchParams.get("LH_BIN")).toBe("1");
});

test("auctions allowed drops LH_BIN; price bounds, category, and marketplace domain apply", () => {
  const u = new URL(
    ebayWebUrl({ ...base, includeAuctions: true, priceFloor: 50, priceCap: 500, categoryId: "9355" }, "EBAY_GB"),
  );
  expect(u.host).toBe("www.ebay.co.uk");
  expect(u.searchParams.get("LH_BIN")).toBeNull();
  expect(u.searchParams.get("_udlo")).toBe("50");
  expect(u.searchParams.get("_udhi")).toBe("500");
  expect(u.searchParams.get("_sacat")).toBe("9355");
});

test("unmapped marketplace degrades to a working ebay.com link", () => {
  expect(new URL(ebayWebUrl(base, "EBAY_XX")).host).toBe("www.ebay.com");
});
