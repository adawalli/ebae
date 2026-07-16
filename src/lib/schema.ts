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

// One row per person. email is the identity anchor (lowercased by callers) rather than
// sub, because the Cloudflare Access policy allowlists emails and single mode has no
// IdP at all; sub is null until an IdP-backed first login stamps it. eBay creds and
// snooze live here as columns, not side tables: one set per user, no independent
// lifecycle.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  sub: text("sub").unique(),
  email: text("email").notNull().unique(),
  ebayClientId: text("ebay_client_id"),
  // AES-256-GCM, "v1:<iv>:<ct+tag>" (see crypto.ts). Write-only: no API ever returns it.
  ebayClientSecretEnc: text("ebay_client_secret_enc"),
  ebayEnv: text("ebay_env").notNull().default("production"),
  ebayMarketplace: text("ebay_marketplace").notNull().default("EBAY_US"),
  // Last time these creds minted a token, stamped on save after live validation.
  ebayVerifiedAt: timestamp("ebay_verified_at", { withTimezone: true }),
  // Optional overnight poll snooze, per user. start/end are minutes-from-midnight in
  // `snooze_tz` (IANA; null = server timezone). Loaded into the poller cache and written
  // through on UI change, same as searches/channels.
  snoozeEnabled: boolean("snooze_enabled").notNull().default(false),
  snoozeStart: integer("snooze_start").notNull().default(60), // 01:00
  snoozeEnd: integer("snooze_end").notNull().default(420), // 07:00
  snoozeTz: text("snooze_tz"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// user_id is nullable across searches/channels/alerts only because the boot-time claim
// (claim.ts) backfills pre-multi-user rows; the app always writes it, and the poller
// skips null-owner searches so unclaimed rows stay inert.
export const searches = pgTable("searches", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
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
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("discord"),
  webhookUrl: text("webhook_url").notNull(),
  enabled: boolean("enabled").notNull().default(true),
});

// Web Push targets. A separate table rather than a `channels` row: webhook_url is NOT
// NULL and a subscription carries three values, so overloading it would mean JSON in a
// URL column - which breaks the API's tail-masking and the SSRF allowlist alike.
// user_id is notNull here, unlike searches/channels/alerts: this table postdates
// multi-user, so claim.ts has no legacy rows to backfill.
export const pushSubs = pgTable("push_subs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // text, never varchar(n): the push services reserve the right to change the shape of
  // these URLs, and lengths already vary by vendor (FCM ~200, Apple ~400, WNS 500+).
  // Unique so a re-subscribe upserts instead of accumulating a row per browser launch -
  // iOS silently rotates endpoints, so the same device re-subscribes often.
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(), // 87 chars: a P-256 point (RFC 8291)
  auth: text("auth").notNull(), // 22 chars: 16 octets
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The VAPID keypair, generated on first use when the env vars aren't set (id is always
// 1). Generated once and reused forever: rotating it silently invalidates every push_subs
// row, since a subscription is bound to the key that created it.
export const vapidKeys = pgTable("vapid_keys", {
  id: integer("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Daily eBay API call counter, persisted so a restart doesn't reset tracking to
// zero. Written opportunistically (piggybacks on poll writes + the 12h reload) so
// it never opens a connection just for this; a reboot loses at most the calls
// since the last write. day = new Date().toDateString(), matching the in-memory key.
// Keyed by (user_id, day): each user brings their own eBay app, so each has their own
// daily ceiling to track.
export const apiUsage = pgTable(
  "api_usage",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    used: integer("used").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
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
