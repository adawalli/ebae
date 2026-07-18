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
  // is idle, which is the common case; larger only while the owner is over budget pace.
  effectiveIntervalMin: number;
  // Calls a day this search costs, market sample included. Server-side so the per-row figures
  // sum to StatusInfo.quota.projected instead of being derived twice from different formulas.
  callsPerDay: number;
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
};

// Price context for an alert embed. basis "market" = the daily unfiltered market median
// (preferred, reflects the whole market); basis "recent" = median of prior priced alerts
// for the search (in-band fallback, gated on `count` >= a real sample).
export type PriceContext = { typical: number | null; count: number; basis: "market" | "recent" };

// conditionId is dropped: it exists only to decide suppression while polling, which happens
// before an alert row is written, so the alerts table has no column for it.
export type Alert = Omit<Item, "conditionId"> & {
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
    ceiling: number;
    // What the current configuration will spend over a full day, and how much of that should
    // already be spent at this point in the day. Both computed server-side, off the same
    // numbers the poller bills against, so the dashboard can't drift from the enforced counter.
    projected: number;
    expected: number;
    governor: { active: boolean; factor: number };
  };
  snooze: { active: boolean; window: string | null; dailyMinutes: number };
  errors: PollError[];
  user: { email: string };
  version: string;
};
