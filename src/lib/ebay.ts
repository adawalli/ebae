import type { Item, Search } from "./types";

export const MOCK = !process.env.EBAY_CLIENT_ID;
export const MARKETPLACE = process.env.EBAY_MARKETPLACE ?? "EBAY_US";

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
  return data.access_token;
}

// Newest-first page 1 of the Browse API for one saved search
export async function searchNewlyListed(s: Search): Promise<Item[]> {
  if (MOCK) return mockSearch(s);

  const filters = [
    // always constrain buying options: without a filter eBay returns auctions too.
    // includeAuctions is the source of truth (binOnly is its UI inverse); default is BIN-only.
    s.includeAuctions ? "buyingOptions:{FIXED_PRICE|AUCTION}" : "buyingOptions:{FIXED_PRICE}",
  ];
  if (s.priceCap != null) filters.push(`price:[..${s.priceCap}]`, "priceCurrency:USD");

  const params = new URLSearchParams({ q: s.q, sort: "newlyListed", limit: "50" });
  if (s.categoryId) params.set("category_ids", s.categoryId);
  if (filters.length) params.set("filter", filters.join(","));

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

function mockItem(s: Search, n: number): Item {
  const id = `v1|mock-${s.id}-${n}|0`;
  const cap = s.priceCap ?? 500;
  const price = Math.round(cap * (0.35 + ((n * 7919) % 66) / 100) * 100) / 100; // stays under the cap, like the real filter
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
    return pool;
  }
  // ~40% of polls surface a brand-new listing
  if (Math.random() < 0.4) {
    pool.unshift(mockItem(s, ++st.counter));
    if (pool.length > 50) pool.pop();
  }
  return pool;
}
