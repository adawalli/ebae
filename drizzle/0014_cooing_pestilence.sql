ALTER TABLE "channels" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "channel_id" integer;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;
