CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"sub" text,
	"email" text NOT NULL,
	"ebay_client_id" text,
	"ebay_client_secret_enc" text,
	"ebay_env" text DEFAULT 'production' NOT NULL,
	"ebay_marketplace" text DEFAULT 'EBAY_US' NOT NULL,
	"ebay_verified_at" timestamp with time zone,
	"snooze_enabled" boolean DEFAULT false NOT NULL,
	"snooze_start" integer DEFAULT 60 NOT NULL,
	"snooze_end" integer DEFAULT 420 NOT NULL,
	"snooze_tz" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_sub_unique" UNIQUE("sub"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DROP TABLE "settings" CASCADE;--> statement-breakpoint
-- Existing api_usage rows are global, so they have no user to attribute to and would
-- block the NOT NULL user_id. Dropped: today's call counter resets once, on migration
-- day, and eBay enforces its own quota regardless.
TRUNCATE TABLE "api_usage";--> statement-breakpoint
ALTER TABLE "api_usage" DROP CONSTRAINT "api_usage_pkey";--> statement-breakpoint
ALTER TABLE "api_usage" ADD COLUMN "user_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_user_id_day_pk" PRIMARY KEY("user_id","day");--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "user_id" integer;--> statement-breakpoint
ALTER TABLE "api_usage" ADD CONSTRAINT "api_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
