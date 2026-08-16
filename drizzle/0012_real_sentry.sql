ALTER TABLE "alerts" ADD COLUMN "kind" text DEFAULT 'listing' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "previous_price" numeric;--> statement-breakpoint
ALTER TABLE "tracked_items" ADD COLUMN "notified_price" numeric;--> statement-breakpoint
ALTER TABLE "tracked_items" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
WITH originals AS (
  SELECT DISTINCT ON ("search_id", "item_id")
    "search_id", "item_id", "price", "title", "currency", "shipping_cost", "buying_option", "condition", "image_url", "item_url"
  FROM "alerts"
  WHERE "kind" = 'listing'
  ORDER BY "search_id", "item_id", "created_at", "id"
)
UPDATE "tracked_items" AS t
SET
  "notified_price" = COALESCE(o."price", t."last_price"),
  "snapshot" = jsonb_build_object(
    'itemId', o."item_id",
    'title', o."title",
    'price', o."price",
    'currency', o."currency",
    'shippingCost', o."shipping_cost",
    'buyingOption', o."buying_option",
    'condition', o."condition",
    'conditionId', NULL,
    'imageUrl', o."image_url",
    'itemUrl', o."item_url",
    'itemEndDate', NULL,
    'bestOffer', t."price_kind" = 'offer_cap'
  )
FROM originals AS o
WHERE t."state" = 'active' AND o."search_id" = t."search_id" AND o."item_id" = t."item_id";--> statement-breakpoint
UPDATE "tracked_items"
SET "notified_price" = "last_price"
WHERE "state" = 'active' AND "notified_price" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_listing_search_item_idx" ON "alerts" USING btree ("search_id","item_id") WHERE "alerts"."kind" = 'listing';--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_price_drop_search_item_price_idx" ON "alerts" USING btree ("search_id","item_id","price") WHERE "alerts"."kind" = 'price_drop';--> statement-breakpoint
DROP INDEX "alerts_search_item_idx";
