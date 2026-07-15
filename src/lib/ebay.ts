import { log } from "./log";
import type { ConditionKey, Item, Search } from "./types";

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

// The active marketplace's currency, surfaced to the UI (via /api/status) so figures the
// poller computes server-side (e.g. the market-median badge) render with the right symbol.
export const CURRENCY = MARKETPLACE_CURRENCY[MARKETPLACE] ?? "USD";

// Condition presets -> Browse `conditionIds` values. USED spans excellent..acceptable
// (3000-6000) but omits 7000 "for parts/not working" - the junk tier most searches want
// gone. Keys are the only values validate.ts lets through. Note: these are condition IDs,
// so they go in `conditionIds`, NOT the `conditions` filter (which takes only the coarse
// NEW/USED/UNSPECIFIED enums and 400s on numeric IDs).
// Keyed by ConditionKey so adding a preset to CONDITION_KEYS (types.ts) is a compile error
// here until its ID mapping is supplied — the whitelist (validate.ts) and UI (page.tsx)
// derive from the same source, so the three can't silently drift.
// null = no server-side filter; see conditionExcluded below.
const CONDITION_FILTER: Record<ConditionKey, string | null> = {
  NOT_PARTS: null,
  NEW: "1000",
  USED: "3000|4000|5000|6000",
};

// eBay's "for parts or not working" tier (rendered "Parts Only" on the web).
export const FOR_PARTS_ID = "7000";

// NOT_PARTS keeps eBay's whole "Any condition" result set but drops the for-parts tier here
// rather than through `conditionIds`. That filter is a whitelist with no negation, so the
// only server-side spelling of "everything but 7000" is to name the other 15 IDs - which
// would drop listings whose category specifies no condition at all, and would rot every time
// eBay adds an ID (2990/3010 arrived for apparel, 2010-2030 for refurb tiers). Naming the one
// ID we actually exclude can't rot. Pure + exported for tests.
export function conditionExcluded(item: Item, conditions: string | null): boolean {
  return conditions === "NOT_PARTS" && item.conditionId === FOR_PARTS_ID;
}

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
export function browseFilters(s: Search): string[] {
  const filters = [
    // always constrain buying options: without a filter eBay returns auctions too.
    // includeAuctions is the source of truth (binOnly is its UI inverse); default is BIN-only.
    s.includeAuctions ? "buyingOptions:{FIXED_PRICE|AUCTION}" : "buyingOptions:{FIXED_PRICE}",
  ];
  // eBay accepts [min..max], [min..], or [..max] — build whichever bounds are set.
  if (s.priceFloor != null || s.priceCap != null) {
    const lo = s.priceFloor ?? "";
    const hi = s.priceCap ?? "";
    filters.push(`price:[${lo}..${hi}]`, `priceCurrency:${CURRENCY}`);
  }
  // numeric condition IDs belong in `conditionIds`; the `conditions` filter only takes the
  // NEW/USED/UNSPECIFIED enums and 400s on IDs (which would back the search off to silence).
  const cond = s.conditions as ConditionKey | null; // validated to a ConditionKey (or null) at the API boundary
  if (cond && CONDITION_FILTER[cond]) filters.push(`conditionIds:{${CONDITION_FILTER[cond]}}`);
  return filters;
}

// The market sample's search: keeps the price FLOOR but drops the cap. The floor filters out
// the sub-band accessories/parts that share the query's keywords (mounts, cables, "for parts")
// — without it a loose keyword query's median collapses to accessory noise (measured $23 for a
// doorbell that actually lists ~$760). Dropping the cap lets items priced above the user's
// ceiling into the sample so the median reflects the true going rate. Pure + exported so the
// keep-floor/drop-cap contract is locked by a test.
export function marketSampleSearch(s: Search): Search {
  return { ...s, priceCap: null };
}

// Shared Browse item_summary/search call. searchNewlyListed and sampleMarket differ only in
// page size and (via marketSampleSearch) the price bounds, so auth/params/error-handling/
// parsing live here once — a fix to any of those can't land in one path and miss the other.
async function browseSearch(s: Search, limit: number): Promise<Item[]> {
  const filters = browseFilters(s);
  const params = new URLSearchParams({ q: s.q, sort: "newlyListed", limit: String(limit) });
  if (s.categoryId) params.set("category_ids", s.categoryId);
  if (filters.length) params.set("filter", filters.join(","));
  elog.debug({ q: s.q, filters: filters.join(","), marketplace: MARKETPLACE, limit }, "eBay request");
  const res = await fetch(`${API_HOST}/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${await token()}`, "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE },
  });
  if (!res.ok) throw new Error(`eBay search failed (${s.q}): ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { itemSummaries?: EbaySummary[] };
  return (data.itemSummaries ?? []).map(normalize);
}

// Newest-first page 1 of the Browse API for one saved search. limit 200 (Browse max) is one
// call but covers 200 newly-listed items per poll, so a hot search or a long snooze can't
// silently drop new listings off a 50-item page 1.
// ponytail: single page; if 200 new between two polls ever happens, add offset paging.
export async function searchNewlyListed(s: Search): Promise<Item[]> {
  if (MOCK) {
    elog.debug({ q: s.q }, "mock search");
    return mockSearch(s);
  }
  return browseSearch(s, 200);
}

// Market sample: same item criteria (q, category, condition, price floor) but with the cap
// removed, so its median reflects the true going rate even for a deal-hunt search whose cap
// would clip it — while the kept floor keeps sub-band accessories out of the median. Newest
// 100; active asking prices only (Browse has no sold data).
export async function sampleMarket(s: Search): Promise<Item[]> {
  if (MOCK) {
    elog.debug({ q: s.q }, "mock market sample");
    return mockMarket(s);
  }
  return browseSearch(marketSampleSearch(s), 100);
}

type EbaySummary = {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  shippingOptions?: { shippingCost?: { value: string } }[];
  buyingOptions?: string[];
  condition?: string;
  conditionId?: string;
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
    conditionId: i.conditionId ?? null,
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
// [display name, condition ID] - IDs let the mock mirror the real filters exactly.
const CONDITIONS: [string, string][] = [
  ["New", "1000"],
  ["Open box", "1500"],
  ["Excellent", "4000"],
  ["Used", "3000"],
  ["Pre-owned", "3000"],
  ["For parts or not working", FOR_PARTS_ID],
];

// Mirror the live condition filtering in mock mode so the feature is exercisable without
// eBay credentials. Derived from CONDITION_FILTER rather than matching display strings, so
// a preset's ID mapping can't drift from what mock mode shows. Note "Open box" (1500)
// matches neither NEW nor USED here, which is faithful: it doesn't live-either.
// Takes the whole Item, not a field: `condition` (display text) and `conditionId` are both
// string | null, so a field parameter lets a caller pass the wrong one with no type error -
// which silently empties the sample, since no display name matches a numeric ID.
function mockConditionOk(item: Item, conditions: string | null): boolean {
  if (!conditions) return true;
  if (conditions === "NOT_PARTS") return !conditionExcluded(item, conditions);
  const ids = CONDITION_FILTER[conditions as ConditionKey];
  return ids != null && item.conditionId != null && ids.split("|").includes(item.conditionId);
}

function mockItem(s: Search, n: number): Item {
  const id = `v1|mock-${s.id}-${n}|0`;
  const [condition, conditionId] = CONDITIONS[n % CONDITIONS.length];
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
    condition,
    conditionId,
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
  return pool.filter((i: Item) => mockConditionOk(i, s.conditions));
}

// Mock market sample: prices centered ~$500 regardless of the search's band, so the
// market-baseline feature is exercisable without eBay creds. Deterministic per index so a
// band-limited (e.g. 100-300) mock search visibly shows a higher "market" figure.
function mockMarket(s: Search): Item[] {
  return Array.from({ length: 40 }, (_, n) => ({
    ...mockItem(s, n),
    price: 400 + ((n * 16) % 21) * 10, // 400..600, median ~500 — independent of the price band
  })).filter((i) => mockConditionOk(i, s.conditions));
}
