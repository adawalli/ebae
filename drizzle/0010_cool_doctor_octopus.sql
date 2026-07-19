ALTER TABLE "searches" ALTER COLUMN "track_sold" SET DEFAULT true;--> statement-breakpoint
UPDATE "searches" SET "track_sold" = true WHERE "track_sold" = false;
