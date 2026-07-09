import { log } from "./log";
import type { Item, Search } from "./types";

const elog = log.child({ component: "ebay" });

export const MOCK = !process.env.EBAY_CLIENT_ID;
export const MARKETPLACE = process.env.EBAY_MARKETPLACE ?? "EBAY_US";

const MARKETPLACE_CURRENCY: Record<string, string> = {
  EBAY_US: "USD",
  EBAY_CA: "CAD",
  EBAY_GB: "GBP",
  EBAY_AU: "AUD",
  EBAY_DE: "EUR",
  EBAY_FR: "EUR",
  EBAY_IT: "EUR",
  EBAY_ES: "EUR",
};

// Condition presets -> Browse `conditionIds` values. USED spans excellent..acceptable
// (3000-6000) but omits 7000 "for parts/not working" - the junk tier most searches want
// gone. Keys are the only values validate.ts lets through. Note: these are condition IDs,
// so they go in `conditionIds`, NOT the `conditions` filter (which takes only the coarse
// NEW/USED/UNSPECIFIED enums and 400s on numeric IDs).
const CONDITION_FILTER: Record<string, string> = {
  NEW: "1000",
  USED: "3000|4000|5000|6000",
};

const SANDBOX = process.env.EBAY_ENV === "sandbox";
const AUTH_HOST = SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const API_HOST = AUTH_HOST;

type Token = { value: string; expiresAt: number };
const g = globalThis as typeof globalThis & { __ebaeToken?: Token; __ebaeMock?: MockState };

export function tokenExpiresAt(): string | null {
  return g.__ebaeToken ? new Date(g.__ebaeToken.expiresAt).toISOString() : null;
}

async function token(): Promise<string> {
  const cached = g.__ebaeToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const res = await fetch(`${AUTH_HOST}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error(`eBay token request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  g.__ebaeToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  elog.info({ expiresIn: data.expires_in }, "token acquired"); // never log the token value
  return data.access_token;
}

// Browse `filter` clauses for a search. Pure + exported so the exact contract (field
// names, condition-ID mapping, price-bound syntax) is unit-tested — mock mode bypasses
// this whole path, which is how a `conditions` vs `conditionIds` mistake could ship.
export function browseFilters(s: Search, includePrice = true): string[] {
  const filters = [
    // always constrain buying options: without a filter eBay returns auctions too.
    // includeAuctions is the source of truth (binOnly is its UI inverse); default is BIN-only.
    s.includeAuctions ? "buyingOptions:{FIXED_PRICE|AUCTION}" : "buyingOptions:{FIXED_PRICE}",
  ];
  // eBay accepts [min..max], [min..], or [..max] — build whichever bounds are set.
  // includePrice=false drops the band entirely for the market-baseline sample (sampleMarket).
  if (includePrice && (s.priceFloor != null || s.priceCap != null)) {
    const lo = s.priceFloor ?? "";
    const hi = s.priceCap ?? "";
    filters.push(`price:[${lo}..${hi}]`, `priceCurrency:${MARKETPLACE_CURRENCY[MARKETPLACE] ?? "USD"}`);
  }
  // numeric condition IDs belong in `conditionIds`; the `conditions` filter only takes the
  // NEW/USED/UNSPECIFIED enums and 400s on IDs (which would back the search off to silence).
  if (s.conditions && CONDITION_FILTER[s.conditions]) filters.push(`conditionIds:{${CONDITION_FILTER[s.conditions]}}`);
  return filters;
}

// Newest-first page 1 of the Browse API for one saved search
export async function searchNewlyListed(s: Search): Promise<Item[]> {
  if (MOCK) {
    elog.debug({ q: s.q }, "mock search");
    return mockSearch(s);
  }

  const filters = browseFilters(s);

  // limit 200 (Browse max) is one call but covers 200 newly-listed items per poll, so a
  // hot search or a long snooze can't silently drop new listings off a 50-item page 1.
  // ponytail: single page; if 200 new between two polls ever happens, add offset paging.
  const params = new URLSearchParams({ q: s.q, sort: "newlyListed", limit: "200" });
  if (s.categoryId) params.set("category_ids", s.categoryId);
  if (filters.length) params.set("filter", filters.join(","));

  elog.debug({ q: s.q, filters: filters.join(","), marketplace: MARKETPLACE }, "eBay request");
  const res = await fetch(`${API_HOST}/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      Authorization: `Bearer ${await token()}`,
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE,
    },
  });
  if (!res.ok) throw new Error(`eBay search failed (${s.q}): ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { itemSummaries?: EbaySummary[] };
  return (data.itemSummaries ?? []).map(normalize);
}

// Unfiltered market sample: same item criteria (q, category, condition) but WITHOUT the
// price band, so its median reflects the true going rate even for a deal-hunt search whose
// own band would clip it. Newest 100; active asking prices only (Browse has no sold data).
export async function sampleMarket(s: Search): Promise<Item[]> {
  if (MOCK) {
    elog.debug({ q: s.q }, "mock market sample");
    return mockMarket(s);
  }
  const filters = browseFilters(s, false); // drop the price band
  const params = new URLSearchParams({ q: s.q, sort: "newlyListed", limit: "100" });
  if (s.categoryId) params.set("category_ids", s.categoryId);
  if (filters.length) params.set("filter", filters.join(","));
  const res = await fetch(`${API_HOST}/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${await token()}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE },
  });
  if (!res.ok) throw new Error(`eBay market sample failed (${s.q}): ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { itemSummaries?: EbaySummary[] };
  return (data.itemSummaries ?? []).map(normalize);
}

type EbaySummary = {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  shippingOptions?: { shippingCost?: { value: string } }[];
  buyingOptions?: string[];
  condition?: string;
  image?: { imageUrl: string };
  thumbnailImages?: { imageUrl: string }[];
  itemWebUrl: string;
};

function normalize(i: EbaySummary): Item {
  const ship = i.shippingOptions?.[0]?.shippingCost?.value;
  return {
    itemId: i.itemId,
    title: i.title,
    price: i.price ? parseFloat(i.price.value) : null,
    currency: i.price?.currency ?? "USD",
    shippingCost: ship != null ? parseFloat(ship) : null,
    buyingOption: i.buyingOptions?.includes("FIXED_PRICE") ? "FIXED_PRICE" : "AUCTION",
    condition: i.condition ?? null,
    imageUrl: i.image?.imageUrl ?? i.thumbnailImages?.[0]?.imageUrl ?? null,
    itemUrl: i.itemWebUrl,
  };
}

// ---------- mock mode (no EBAY_CLIENT_ID set) ----------
// Fakes a live marketplace so the whole poll → dedupe → alert pipeline runs
// without developer credentials: a stable pool per search, plus occasional
// brand-new listings so alerts keep flowing.

type MockState = { pools: Map<number, Item[]>; counter: number };

const VARIANTS = [
  "mint condition, boxed",
  "excellent, ships fast",
  "barely used, no reserve",
  "estate find, as pictured",
  "new old stock, sealed",
  "tested & working, EX+",
  "recent service, receipts included",
  "rare variant, collector owned",
];
const CONDITIONS = ["New", "Open box", "Excellent", "Used", "Pre-owned", "For parts or not working"];

// Mirror the live `conditions` filter in mock mode so the feature is exercisable
// without eBay credentials. NEW = brand new only; USED = anything used-ish except
// the for-parts tier (matching CONDITION_FILTER's omission of ID 7000).
function mockConditionOk(condition: string | null, conditions: string | null): boolean {
  if (!conditions) return true;
  if (conditions === "NEW") return condition === "New";
  return condition != null && condition !== "New" && condition !== "For parts or not working";
}

function mockItem(s: Search, n: number): Item {
  const id = `v1|mock-${s.id}-${n}|0`;
  // mirror the live price:[floor..cap] filter so mock alerts respect both bounds
  const lo = s.priceFloor ?? 0;
  const hi = Math.max(s.priceCap ?? 500, lo + 50);
  const price = Math.round((lo + (hi - lo) * (0.15 + ((n * 7919) % 60) / 100)) * 100) / 100;
  const auction = s.includeAuctions && n % 3 === 0;
  return {
    itemId: id,
    title: `${s.q} - ${VARIANTS[n % VARIANTS.length]}`,
    price,
    currency: "USD",
    shippingCost: n % 4 === 0 ? 0 : Math.round((5 + (n % 30)) * 100) / 100,
    buyingOption: auction ? "AUCTION" : "FIXED_PRICE",
    condition: CONDITIONS[n % CONDITIONS.length],
    imageUrl: `https://picsum.photos/seed/ebae-${s.id}-${n}/264/264`,
    itemUrl: `https://www.ebay.com/itm/mock-${s.id}-${n}`,
  };
}

function mockSearch(s: Search): Item[] {
  // time-seeded counter: ids stay unique across restarts even though seen_items persist
  const st = (g.__ebaeMock ??= { pools: new Map(), counter: Math.floor(Date.now() / 1000) });
  let pool = st.pools.get(s.id);
  if (!pool) {
    // first poll: a page of "existing" listings for the seed pass
    pool = Array.from({ length: 8 }, () => mockItem(s, ++st.counter));
    st.pools.set(s.id, pool);
  } else if (Math.random() < 0.4) {
    // ~40% of polls surface a brand-new listing
    pool.unshift(mockItem(s, ++st.counter));
    if (pool.length > 50) pool.pop();
  }
  // condition filter is server-side for the live API, so mirror it here
  return pool.filter((i: Item) => mockConditionOk(i.condition, s.conditions));
}

// Mock market sample: prices centered ~$500 regardless of the search's band, so the
// market-baseline feature is exercisable without eBay creds. Deterministic per index so a
// band-limited (e.g. 100-300) mock search visibly shows a higher "market" figure.
function mockMarket(s: Search): Item[] {
  return Array.from({ length: 40 }, (_, n) => ({
    ...mockItem(s, n),
    price: 400 + ((n * 16) % 21) * 10, // 400..600, median ~500 — independent of the price band
  })).filter((i) => mockConditionOk(i.condition, s.conditions));
}
