ALTER TABLE "searches" ADD COLUMN "market_median" numeric;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "market_sampled_at" timestamp with time zone;
