import {
  boolean,
  integer,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Source of truth for the schema and for migrations (bun run db:generate). numeric
// columns use mode:"number" so price fields read/write as numbers (no manual
// coercion); the generated SQL type is still NUMERIC.

export const searches = pgTable("searches", {
  id: serial("id").primaryKey(),
  q: text("q").notNull(),
  categoryId: text("category_id"),
  priceFloor: numeric("price_floor", { mode: "number" }),
  priceCap: numeric("price_cap", { mode: "number" }),
  binOnly: boolean("bin_only").notNull().default(true),
  includeAuctions: boolean("include_auctions").notNull().default(false),
  // eBay condition filter: "NEW" | "USED" | null (any). Mapped to condition IDs at
  // the API boundary (see ebay.ts); a server-side filter, so changing it re-seeds.
  conditions: text("conditions"),
  // Case-insensitive title exclusions, comma/newline separated. Client-side (the
  // Browse API has no negative-keyword support): matching listings are marked seen
  // but never alerted. Not a match field - the seen set stays comprehensive.
  excludeTerms: text("exclude_terms"),
  // Active-market price baseline: median asking price of a daily unfiltered sample (same
  // item criteria as the search but WITHOUT the price band), so an alert can say "market
  // ~$X" instead of only comparing to other in-band alerts. Poller-managed, not user-set.
  marketMedian: numeric("market_median", { mode: "number" }),
  marketSampledAt: timestamp("market_sampled_at", { withTimezone: true }),
  intervalMin: integer("interval_min").notNull().default(5),
  enabled: boolean("enabled").notNull().default(true),
  seeded: boolean("seeded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const seenItems = pgTable(
  "seen_items",
  {
    searchId: integer("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.searchId, t.itemId] })],
);

export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull().default("discord"),
  webhookUrl: text("webhook_url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
});

// Daily eBay API call counter, persisted so a restart doesn't reset tracking to
// zero. Written opportunistically (piggybacks on poll writes + the 12h reload) so
// it never opens a connection just for this; a reboot loses at most the calls
// since the last write. day = new Date().toDateString(), matching the in-memory key.
export const apiUsage = pgTable("api_usage", {
  day: text("day").primaryKey(),
  used: integer("used").notNull().default(0),
});

// Single-row global settings (id is always 1). Currently just the optional
// overnight poll snooze; start/end are minutes-from-midnight in `snooze_tz`
// (IANA; null = server timezone). Loaded into the poller cache and written
// through on UI change, same as searches/channels.
export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  snoozeEnabled: boolean("snooze_enabled").notNull().default(false),
  snoozeStart: integer("snooze_start").notNull().default(60), // 01:00
  snoozeEnd: integer("snooze_end").notNull().default(420), // 07:00
  snoozeTz: text("snooze_tz"),
});

export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    searchId: integer("search_id").references(() => searches.id, { onDelete: "set null" }),
    searchQ: text("search_q").notNull(),
    itemId: text("item_id").notNull(),
    title: text("title").notNull(),
    price: numeric("price", { mode: "number" }),
    currency: text("currency").notNull().default("USD"),
    shippingCost: numeric("shipping_cost", { mode: "number" }),
    buyingOption: text("buying_option").notNull().default("FIXED_PRICE"),
    condition: text("condition"),
    imageUrl: text("image_url"),
    itemUrl: text("item_url").notNull(),
    // null = created but not yet confirmed delivered to any channel. The poller retries
    // undelivered rows (redeliverPending) so a webhook outage doesn't lose an alert; set
    // at insert time when there are no channels (nothing to deliver to).
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // DB backstop for the in-memory dedupe: even if a reload race lets a tick re-process an
  // item, the second alerts insert conflicts and is dropped (onConflictDoNothing). NULLS
  // DISTINCT leaves orphaned alerts (search_id set null on delete) unconstrained, which is
  // fine - they're history, never re-alerted.
  (t) => [uniqueIndex("alerts_search_item_idx").on(t.searchId, t.itemId)],
);
