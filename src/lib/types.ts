// User-selectable condition presets, shared so the places that must agree can't drift:
// the API whitelist (validate.ts), the Browse condition-ID mapping (ebay.ts
// CONDITION_FILTER, typed by this), and the UI labels below. null = any condition.
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

export type Search = {
  id: number;
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

export type PollError = { time: string; searchQ: string | null; message: string };

// Snooze config as sent over the wire / edited in the UI. start/end are "HH:MM"
// local times in `tz` (IANA; null = server timezone). The poller stores them as
// minutes-from-midnight internally.
export type SnoozeConfig = { enabled: boolean; start: string; end: string; tz: string | null };

export type StatusInfo = {
  ready: boolean;
  bootError: string | null;
  poller: { running: boolean; bootedAt: string | null; timers: number };
  ebay: { mode: "mock" | "live"; marketplace: string; currency: string; tokenExpiresAt: string | null };
  quota: { used: number; ceiling: number };
  snooze: { active: boolean; window: string | null; dailyMinutes: number };
  errors: PollError[];
  version: string;
};
