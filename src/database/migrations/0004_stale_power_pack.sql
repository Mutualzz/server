ALTER TABLE "discord_users" ALTER COLUMN "utcOffsetMinutes" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "discord_users" ALTER COLUMN "utcOffsetMinutes" SET NOT NULL;