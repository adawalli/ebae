export type Search = {
  id: number;
  q: string;
  categoryId: string | null;
  priceCap: number | null;
  binOnly: boolean;
  includeAuctions: boolean;
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

export type Alert = Item & {
  id: number;
  searchId: number | null;
  searchQ: string;
  createdAt: string;
};

export type PollError = { time: string; searchQ: string | null; message: string };

export type StatusInfo = {
  ready: boolean;
  bootError: string | null;
  poller: { running: boolean; bootedAt: string | null; timers: number };
  ebay: { mode: "mock" | "live"; marketplace: string; tokenExpiresAt: string | null };
  quota: { used: number; ceiling: number };
  errors: PollError[];
  version: string;
};
