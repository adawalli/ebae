import { log } from "./log";
import { MARKETPLACE_CURRENCY, type Item, type Search } from "./types";

const elog = log.child({ component: "ebay" });

// A marketplace's currency, surfaced to the UI (via /api/status) so figures the poller
// computes server-side (e.g. the market-median badge) render with the right symbol.
export function currencyFor(marketplace: string): string {
  return MARKETPLACE_CURRENCY[marketplace] ?? "USD";
}

// The marketplaces a user may save (validate.ts). currencyFor falls back to USD, so membership
// has to be asked explicitly - otherwise a typo'd marketplace would price a UK search in dollars.
export const MARKETPLACES = Object.keys(MARKETPLACE_CURRENCY);

// One user's eBay developer keys. clientSecret is plaintext: the poller decrypts it once at
// reload and holds it in-process only, so it never sits in a module global or a log line.
export type EbayCreds = {
  userId: number;
  clientId: string;
  clientSecret: string;
  env: "production" | "sandbox";
  marketplace: string;
};

// eBay's "for parts or not working" tier (rendered "Parts Only" on the web).
export const FOR_PARTS_ID = "7000";

// The new-family IDs: 1000 New, 1500 New other/Open box, 1750 New with defects. All three are
// sold as new, so a "New only" search should see them. 2750 "Like New" is NOT here - it's a
// used item in nice shape, and belongs to USED.
const NEW_IDS = new Set(["1000", "1500", "1750"]);

// Whether a listing fails the search's condition preset. Applied in the poller, not through
// Browse's `conditionIds` filter, and phrased as the IDs each preset EXCLUDES rather than a
// keep-list of the ones it allows. `conditionIds` has no negation, so any server-side keep-list
// silently drops every listing whose category states no condition at all (there is no ID for
// "unspecified"), and rots each time eBay adds one - 2990/3010 arrived for apparel, 2010-2030
// for the refurb tiers, and a keep-list written before them quietly stops matching them.
// A drop-list can only ever be too permissive, which is the safe direction here: a listing you
// didn't want costs a glance, one you never see costs the deal. Pure + exported for tests.
export function conditionExcluded(item: Item, conditions: string | null): boolean {
  const id = item.conditionId;
  if (conditions === "NOT_PARTS") return id === FOR_PARTS_ID;
  if (conditions === "USED") return id === FOR_PARTS_ID || (id != null && NEW_IDS.has(id));
  // NEW is the one preset eBay defines as a closed set, so it keeps rather than drops - but an
  // unspecified conditionId still survives, since "no condition stated" is not "not new".
  if (conditions === "NEW") return id != null && !NEW_IDS.has(id);
  return false; // null = any condition, nothing dropped
}

function hostFor(env: EbayCreds["env"]): string {
  return env === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

// eBay told us to slow down (HTTP 429). Carries how long to wait so the poll loop can reschedule
// off the server's own hint instead of a blind, compounding backoff (see loop.ts retryDelayMs).
export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("eBay rate limited");
    this.name = "RateLimitError";
  }
}

// Wait to use when a 429 carries no Retry-After. eBay's Browse quota is a daily budget that
// resets at midnight Pacific, so a fixed re-check gap (not an ever-growing backoff) is the right
// shape; the loop caps the honored wait at MAX_BACKOFF_MS so the heartbeat stays fresh regardless.
export const RATE_LIMIT_DEFAULT_MS = 15 * 60_000;

// Retry-After is either delay-seconds or an HTTP-date (RFC 9110). Returns null when the header is
// absent or unparseable, so the caller falls back to RATE_LIMIT_DEFAULT_MS. Pure + exported.
export function retryAfterMs(res: Response, now = Date.now()): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

type Token = { value: string; expiresAt: number };
const g = globalThis as typeof globalThis & { __ebaeTokens?: Map<number, Token>; __ebaeMock?: MockState };

// Tokens are per-user: each user brings their own eBay app, so one cache slot can't be shared.
function tokens(): Map<number, Token> {
  return (g.__ebaeTokens ??= new Map());
}

export function tokenExpiresAt(userId: number): string | null {
  const t = tokens().get(userId);
  return t ? new Date(t.expiresAt).toISOString() : null;
}

// Called when a user's creds change: a token minted from the old keys must not outlive them.
export function invalidateToken(userId: number): void {
  tokens().delete(userId);
}

// The raw client-credentials POST, uncached. Also the credentials route's live check on save:
// proving the keys mint a token before we encrypt and store them turns a typo into a message in
// the UI instead of a search that silently never polls. token() is the caching path - a
// validation is not a poll, and the caller invalidates on save anyway.
export async function requestToken(creds: EbayCreds): Promise<Token> {
  const res = await fetch(`${hostFor(creds.env)}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64"),
    },
    // the scope is an eBay-wide identifier, not a host - it stays api.ebay.com in sandbox too
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error(`eBay token request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  elog.info({ userId: creds.userId, expiresIn: data.expires_in }, "token acquired"); // never log the token value
  return { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
}

async function token(creds: EbayCreds): Promise<string> {
  const cached = tokens().get(creds.userId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
  const t = await requestToken(creds);
  tokens().set(creds.userId, t);
  return t.value;
}

// Browse `filter` clauses for a search. Pure + exported so the exact contract (field
// names, condition-ID mapping, price-bound syntax) is unit-tested — mock mode bypasses
// this whole path, which is how a `conditions` vs `conditionIds` mistake could ship.
export function browseFilters(s: Search, currency: string): string[] {
  const filters = [
    // always constrain buying options: without a filter eBay returns auctions too.
    // includeAuctions is the source of truth (binOnly is its UI inverse); default is BIN-only.
    // trackSold also widens to auctions: their winning bids feed the sold median even on a
    // BIN-only search, where the poller follows them without alerting (see loop.ts).
    s.includeAuctions || s.trackSold ? "buyingOptions:{FIXED_PRICE|AUCTION}" : "buyingOptions:{FIXED_PRICE}",
  ];
  // eBay accepts [min..max], [min..], or [..max] — build whichever bounds are set.
  if (s.priceFloor != null || s.priceCap != null) {
    const lo = s.priceFloor ?? "";
    const hi = s.priceCap ?? "";
    filters.push(`price:[${lo}..${hi}]`, `priceCurrency:${currency}`);
  }
  // No condition clause, by design: every preset is enforced in the poller via
  // conditionExcluded (see there for why a server-side conditionIds keep-list loses listings).
  return filters;
}

// The market sample's search: keeps the price FLOOR but drops the cap. The floor filters out
// the sub-band accessories/parts that share the query's keywords (mounts, cables, "for parts")
// — without it a loose keyword query's median collapses to accessory noise (measured $23 for a
// doorbell that actually lists ~$760). Dropping the cap lets items priced above the user's
// ceiling into the sample so the median reflects the true going rate. Pure + exported so the
// keep-floor/drop-cap contract is locked by a test.
export function marketSampleSearch(s: Search): Search {
  // Both auction levers are cleared so the sample stays FIXED_PRICE-only. The market baseline
  // measures what sellers ask, and an auction summary's price is a running bid, not an asking
  // price - trackSold widens the poll (see browseFilters) and includeAuctions is the user's own
  // opt-in, but neither belongs in an asking-price median.
  return { ...s, priceCap: null, trackSold: false, includeAuctions: false };
}

// Shared Browse item_summary/search call. searchNewlyListed and sampleMarket differ only in
// page size and (via marketSampleSearch) the price bounds, so auth/params/error-handling/
// parsing live here once — a fix to any of those can't land in one path and miss the other.
async function browseSearch(creds: EbayCreds, s: Search, limit: number): Promise<Item[]> {
  const filters = browseFilters(s, currencyFor(creds.marketplace));
  const params = new URLSearchParams({ q: s.q, sort: "newlyListed", limit: String(limit) });
  if (s.categoryId) params.set("category_ids", s.categoryId);
  if (filters.length) params.set("filter", filters.join(","));
  elog.debug({ q: s.q, filters: filters.join(","), marketplace: creds.marketplace, limit }, "eBay request");
  const res = await fetch(`${hostFor(creds.env)}/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${await token(creds)}`, "X-EBAY-C-MARKETPLACE-ID": creds.marketplace },
  });
  if (!res.ok) {
    // 429 is a rate-limit signal, not an outage: surface it typed so the loop honors eBay's wait
    // instead of compounding its backoff. Shared by search and the market sample (both go through
    // here); the market sample's own try/catch just logs it, which is the right no-op there.
    if (res.status === 429) throw new RateLimitError(retryAfterMs(res) ?? RATE_LIMIT_DEFAULT_MS);
    throw new Error(`eBay search failed (${s.q}): ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { itemSummaries?: EbaySummary[] };
  return (data.itemSummaries ?? []).map(normalize);
}

// Newest-first page 1 of the Browse API for one saved search. limit 200 (Browse max) is one
// call but covers 200 newly-listed items per poll, so a hot search or a long snooze can't
// silently drop new listings off a 50-item page 1.
// ponytail: single page; if 200 new between two polls ever happens, add offset paging.
export async function searchNewlyListed(creds: EbayCreds, s: Search): Promise<Item[]> {
  return browseSearch(creds, s, 200);
}

// Market sample: same item criteria (q, category, condition, price floor) but with the cap
// removed, so its median reflects the true going rate even for a deal-hunt search whose cap
// would clip it — while the kept floor keeps sub-band accessories out of the median. Newest
// 100; active asking prices only (Browse has no sold data).
export async function sampleMarket(creds: EbayCreds, s: Search): Promise<Item[]> {
  return browseSearch(creds, marketSampleSearch(s), 100);
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
  itemEndDate?: string;
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
    itemEndDate: i.itemEndDate ?? null,
    bestOffer: i.buyingOptions?.includes("BEST_OFFER") ?? false,
  };
}

// ---------- item check (sold-price tracking) ----------

// What one getItem check can tell us about a followed listing. Deliberately narrow: bidCount
// and reservePriceMet are NOT here, because live probing showed both unusable (bidCount comes
// back null even for an ended auction that took no bids, reservePriceMet was null throughout).
// Availability plus sold quantity is the one signal that reads the same for both listing types.
export type CheckResult =
  | { ok: true; price: number | null; availability: string | null; soldQuantity: number }
  | { ok: false; errorId: number | null };

// eBay's "this listing is gone" errors: 11001 not found, 11004 unavailable. Any other failure
// is ours or theirs (auth, rate limit, an outage) and must not be mistaken for a listing that
// ended - hence a throw, so the caller retries on the normal cadence instead of resolving.
const GONE_ERROR_IDS = new Set([11001, 11004]);

type EbayItemDetail = {
  price?: { value: string };
  estimatedAvailabilities?: { estimatedAvailabilityStatus?: string; estimatedSoldQuantity?: number }[];
};

// Re-fetch one previously seen listing to find out how it ended. COMPACT is the cheapest
// fieldgroup that still carries price and availability, and ended listings stay readable for
// days after the fact (verified: a BIN item sold three days prior, auctions minutes after the
// hammer), which is what makes a periodic check-in workable at all.
export async function checkItem(creds: EbayCreds, itemId: string): Promise<CheckResult> {
  const res = await fetch(
    `${hostFor(creds.env)}/buy/browse/v1/item/${encodeURIComponent(itemId)}?fieldgroups=COMPACT`,
    { headers: { Authorization: `Bearer ${await token(creds)}`, "X-EBAY-C-MARKETPLACE-ID": creds.marketplace } },
  );
  if (!res.ok) {
    const body = await res.text();
    let errorId: number | null = null;
    try {
      errorId = (JSON.parse(body) as { errors?: { errorId?: number }[] }).errors?.[0]?.errorId ?? null;
    } catch {
      // a non-JSON error body (a gateway page) is never one of the gone codes; fall through and throw
    }
    if (errorId != null && GONE_ERROR_IDS.has(errorId)) return { ok: false, errorId };
    throw new Error(`eBay item check failed (${itemId}): ${res.status} ${body}`);
  }
  const data = (await res.json()) as EbayItemDetail;
  const avail = data.estimatedAvailabilities?.[0];
  return {
    ok: true,
    price: data.price ? parseFloat(data.price.value) : null,
    availability: avail?.estimatedAvailabilityStatus ?? null,
    soldQuantity: avail?.estimatedSoldQuantity ?? 0,
  };
}

// ---------- mock mode ----------
// Fakes a live marketplace so the whole poll → dedupe → alert pipeline runs
// without developer credentials: a stable pool per search, plus occasional
// brand-new listings so alerts keep flowing. The poller decides when to use it.

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
// [display name, condition ID] - covers each family a preset treats differently, including a
// null ID (a category that states no condition), the case a server-side keep-list would drop.
const CONDITIONS: [string, string | null][] = [
  ["New", "1000"],
  ["Open box", "1500"],
  ["Certified Refurbished", "2000"],
  ["Excellent", "4000"],
  ["Used", "3000"],
  ["Not specified", null],
  ["For parts or not working", FOR_PARTS_ID],
];

function mockItem(s: Search, n: number): Item {
  const id = `v1|mock-${s.id}-${n}|0`;
  const [condition, conditionId] = CONDITIONS[n % CONDITIONS.length];
  // mirror the live price:[floor..cap] filter so mock alerts respect both bounds
  const lo = s.priceFloor ?? 0;
  const hi = Math.max(s.priceCap ?? 500, lo + 50);
  const price = Math.round((lo + (hi - lo) * (0.15 + ((n * 7919) % 60) / 100)) * 100) / 100;
  const auction = (s.includeAuctions || s.trackSold) && n % 3 === 0;
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
    // Short enough that a mock auction's one post-end check lands inside a dev session.
    itemEndDate: auction ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
    bestOffer: !auction && n % 5 === 0,
  };
}

// Mock counterpart to checkItem: every followed listing "sells" at 90% of the price we last
// saw it at, so a dev without eBay keys still watches rows resolve, a sold median build, and
// the deal context switch over to it.
export function mockCheckItem(lastPrice: number | null): CheckResult {
  return {
    ok: true,
    availability: "OUT_OF_STOCK",
    soldQuantity: 1,
    price: lastPrice == null ? null : Math.round(lastPrice * 90) / 100,
  };
}

export function mockSearch(s: Search): Item[] {
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
  return pool.filter((i: Item) => !conditionExcluded(i, s.conditions));
}

// Mock market sample: prices centered ~$500 regardless of the search's band, so the
// market-baseline feature is exercisable without eBay creds. Deterministic per index so a
// band-limited (e.g. 100-300) mock search visibly shows a higher "market" figure.
export function mockMarket(s: Search): Item[] {
  // Build from the same search the live sample uses (marketSampleSearch), so mock and live agree
  // on which listing types the baseline is drawn from - otherwise trackSold/includeAuctions would
  // seed auctions here that the live FIXED_PRICE-only sample never sees.
  const sample = marketSampleSearch(s);
  return Array.from({ length: 40 }, (_, n) => ({
    ...mockItem(sample, n),
    price: 400 + ((n * 16) % 21) * 10, // 400..600, median ~500 — independent of the price band
  })).filter((i) => !conditionExcluded(i, sample.conditions));
}
