// User-selectable condition presets, shared so the places that must agree can't drift:
// the API whitelist (validate.ts), the condition-ID suppression rules (ebay.ts
// conditionExcluded), and the UI labels below. null = any condition.
// Order drives the select's option order, so NOT_PARTS sits next to "Any condition".
export const CONDITION_KEYS = ["NOT_PARTS", "NEW", "USED"] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];

// Keyed by ConditionKey so a new preset is a compile error here rather than a silently
// mislabelled option or badge.
export const CONDITION_LABELS: Record<ConditionKey, string> = {
  NOT_PARTS: "Any (excl. for parts)",
  NEW: "New only",
  USED: "Used (excl. for parts)",
};

// Short forms for the list-view chip, where the select's labels don't fit.
export const CONDITION_BADGE: Record<ConditionKey, string> = {
  NOT_PARTS: "No parts",
  NEW: "New",
  USED: "Used",
};

// The marketplaces a user may save, with the currency each prices in. Lives here rather than
// ebay.ts because the credentials select needs it in the browser and ebay.ts is server-only
// (it pulls in pino via log.ts). ebay.ts and validate.ts read this same map, so the select's
// options and the API's whitelist can't drift apart.
export const MARKETPLACE_CURRENCY: Record<string, string> = {
  EBAY_US: "USD",
  EBAY_CA: "CAD",
  EBAY_GB: "GBP",
  EBAY_AU: "AUD",
  EBAY_DE: "EUR",
  EBAY_FR: "EUR",
  EBAY_IT: "EUR",
  EBAY_ES: "EUR",
};

// How to read a tracked listing's price. "offer_cap" listings accept Best Offer, so eBay
// keeps showing the asking price after a sale - a ceiling on what it went for, not the
// realized price, which is why those rows are excluded from the sold median.
export type PriceKind = "bid" | "fixed" | "offer_cap";

export type Search = {
  id: number;
  userId: number;
  q: string;
  categoryId: string | null;
  priceFloor: number | null;
  priceCap: number | null;
  binOnly: boolean;
  includeAuctions: boolean;
  conditions: string | null; // ConditionKey | null (any)
  excludeTerms: string | null; // comma/newline-separated title exclusions
  marketMedian: number | null; // daily unfiltered market baseline (poller-managed)
  marketSampledAt: string | null;
  trackSold: boolean; // follow surfaced listings to learn what they realized; user-configurable
  intervalMin: number;
  enabled: boolean;
  seeded: boolean;
  createdAt: string;
};

// Search + live poller stats, as served by GET /api/searches
export type SearchStats = Search & {
  seenCount: number;
  hits24: number;
  lastHitAt: string | null;
  lastPolledAt: string | null;
  // intervalMin stretched by the budget governor. Equal to intervalMin whenever the governor
  // is idle, which is the common case; larger only while the remaining saved work exceeds budget.
  effectiveIntervalMin: number;
  // Calls a day this search costs, market sample and due sold-price checks included. Server-side
  // so the per-row figures sum to StatusInfo.quota.projected instead of being derived twice from
  // different formulas.
  callsPerDay: number;
  // Median of what this search's tracked listings actually sold for, or null when it isn't
  // tracking or hasn't learned enough yet. Lives in poller memory, not a column.
  soldMedian: number | null;
  // Sold-price checks already scheduled inside the next 24h - the part of callsPerDay that
  // varies with what the search is currently following rather than with its configuration. Sent
  // so the edit dialog's estimate can match the figure the row beside it is showing.
  checksDue24h: number;
};

// One eBay listing, normalized from Browse item_summary (or the mock generator)
export type Item = {
  itemId: string;
  title: string;
  price: number | null;
  currency: string;
  shippingCost: number | null; // null = unknown, 0 = free
  buyingOption: "FIXED_PRICE" | "AUCTION";
  condition: string | null; // display text, varies by surface ("Parts Only" vs "For parts or not working")
  conditionId: string | null; // eBay's stable numeric id; null when the category doesn't specify one
  imageUrl: string | null;
  itemUrl: string;
  // Auctions only (null on fixed-price listings, and on any summary that omits it). Captured
  // here because it is free on the search summary and absent from getItem's COMPACT view -
  // it's what lets a tracked auction be checked exactly once, just after it ends.
  itemEndDate: string | null;
  // Accepts Best Offer, so the listed price is a ceiling on what it may sell for.
  bestOffer: boolean;
};

// Price context for an alert embed, best basis first. "sold" = median of what this search's
// tracked listings actually realized (when enabled and gated on a real sample); "market" = the daily
// unfiltered market median of asking prices (reflects the whole market); "recent" = median of
// prior priced alerts for the search (in-band fallback, gated on `count` >= a real sample).
export type PriceContext = { typical: number | null; count: number; basis: "sold" | "market" | "recent" };

// conditionId, itemEndDate and bestOffer are dropped: all three exist only to decide something
// while polling (suppression, and how to follow the listing afterwards), which happens before an
// alert row is written, so the alerts table has no column for any of them.
export type Alert = Omit<Item, "conditionId" | "itemEndDate" | "bestOffer"> & {
  id: number;
  searchId: number | null;
  searchQ: string;
  createdAt: string;
};

// userId is null for errors raised before an owner is known (e.g. a cred decrypt failure
// during reload), so status() can still surface them.
export type PollError = { time: string; searchQ: string | null; message: string; userId: number | null };

// A delivery target. webhookUrl is masked to its tail by the API - the full URL is a
// secret and is never returned once saved.
export type Channel = { id: number; kind: string; webhookUrl: string };

// A Web Push target, as the browser's PushSubscription.toJSON() gives it. endpoint is
// bearer-equivalent (anyone holding it can push to the device), so no API returns it.
// Shaped like the browser's payload rather than the DB row so the subscribe route can
// hand it straight to web-push.
export type PushSub = { endpoint: string; p256dh: string; auth: string };

// Body of PUT /api/ebay-credentials. clientSecret is write-only: no API returns it.
export type EbayCredsInput = {
  clientId: string;
  clientSecret: string;
  env: "production" | "sandbox";
  marketplace: string;
};

// Snooze config as sent over the wire / edited in the UI. start/end are "HH:MM"
// local times in `tz` (IANA; null = server timezone). The poller stores them as
// minutes-from-midnight internally.
export type SnoozeConfig = { enabled: boolean; start: string; end: string; tz: string | null };

export type StatusInfo = {
  ready: boolean;
  bootError: string | null;
  poller: { running: boolean; bootedAt: string | null; timers: number };
  // "no-creds" = polling paused until the user saves eBay keys. clientId/env ride here
  // because there is no GET on /api/ebay-credentials; the secret never leaves the server.
  ebay: {
    mode: "live" | "mock" | "no-creds";
    clientId: string | null;
    env: string;
    marketplace: string;
    currency: string;
    tokenExpiresAt: string | null;
  };
  quota: {
    used: number;
    // The part of `used` spent on surplus sold checks, not on the saved configuration. A subset,
    // not a sibling: `remaining` and the governor still judge the whole of `used`, and the UI
    // subtracts this only to ask whether the configuration itself is running hot.
    surplus: number;
    ceiling: number;
    // What the current configuration will spend over a full day, and how much of that should
    // already be spent at this point in the day. Both computed server-side, off the same
    // numbers the poller bills against, so the dashboard can't drift from the enforced counter.
    projected: number;
    expected: number;
    governor: { active: boolean; factor: number };
    remaining: number;
    configuredRemaining: number;
    configuredForecast: number;
    overage: number;
    // Market baselines a floor+cap search costs per day (MARKET_SAMPLE_HOURS, server-only).
    // Here so the new-search preview prices the same way a saved row does.
    marketSamplesPerDay: number;
  };
  snooze: { active: boolean; window: string | null; dailyMinutes: number };
  errors: PollError[];
  user: { email: string };
  version: string;
};
