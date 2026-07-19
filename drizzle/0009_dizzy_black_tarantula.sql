CREATE TABLE "tracked_items" (
	"search_id" integer NOT NULL,
	"item_id" text NOT NULL,
	"price_kind" text DEFAULT 'fixed' NOT NULL,
	"last_price" numeric,
	"currency" text DEFAULT 'USD' NOT NULL,
	"item_end_date" timestamp with time zone,
	"state" text DEFAULT 'active' NOT NULL,
	"sold_price" numeric,
	"resolved_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"checks_used" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_items_search_id_item_id_pk" PRIMARY KEY("search_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "track_sold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tracked_items" ADD CONSTRAINT "tracked_items_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;
