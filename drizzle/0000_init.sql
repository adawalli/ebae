CREATE TABLE "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_id" integer,
	"search_q" text NOT NULL,
	"item_id" text NOT NULL,
	"title" text NOT NULL,
	"price" numeric,
	"currency" text DEFAULT 'USD' NOT NULL,
	"shipping_cost" numeric,
	"buying_option" text DEFAULT 'FIXED_PRICE' NOT NULL,
	"condition" text,
	"image_url" text,
	"item_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'discord' NOT NULL,
	"webhook_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"q" text NOT NULL,
	"category_id" text,
	"price_cap" numeric,
	"bin_only" boolean DEFAULT true NOT NULL,
	"include_auctions" boolean DEFAULT false NOT NULL,
	"interval_min" integer DEFAULT 5 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"seeded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seen_items" (
	"search_id" integer NOT NULL,
	"item_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seen_items_search_id_item_id_pk" PRIMARY KEY("search_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seen_items" ADD CONSTRAINT "seen_items_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;
