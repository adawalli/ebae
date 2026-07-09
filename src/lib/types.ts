export type Search = {
  id: number;
  q: string;
  categoryId: string | null;
  priceFloor: number | null;
  priceCap: number | null;
  binOnly: boolean;
  includeAuctions: boolean;
  conditions: string | null; // "NEW" | "USED" | null (any)
  excludeTerms: string | null; // comma/newline-separated title exclusions
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
  condition: string | null;
  imageUrl: string | null;
  itemUrl: string;
};

// Recent-price context for an alert embed: median of prior priced alerts for the
// same search, and how many contributed (the poller gates display on a real sample).
export type PriceContext = { typical: number | null; count: number };

export type Alert = Item & {
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
  ebay: { mode: "mock" | "live"; marketplace: string; tokenExpiresAt: string | null };
  quota: { used: number; ceiling: number };
  snooze: { active: boolean; window: string | null; dailyMinutes: number };
  errors: PollError[];
  version: string;
};
