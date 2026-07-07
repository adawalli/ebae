CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"snooze_enabled" boolean DEFAULT false NOT NULL,
	"snooze_start" integer DEFAULT 60 NOT NULL,
	"snooze_end" integer DEFAULT 420 NOT NULL,
	"snooze_tz" text
);
