ALTER TABLE "alerts" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
UPDATE "alerts" SET "delivered_at" = "created_at";--> statement-breakpoint
DELETE FROM "alerts" a USING "alerts" b
  WHERE a."search_id" = b."search_id" AND a."item_id" = b."item_id" AND a."id" > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_search_item_idx" ON "alerts" USING btree ("search_id","item_id");
