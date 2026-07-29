CREATE TYPE "public"."dm_privacy" AS ENUM('everyone', 'friends', 'nobody');--> statement-breakpoint
CREATE TYPE "public"."profile_visibility" AS ENUM('everyone', 'friends', 'nobody');--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "whoCanDm" "dm_privacy" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "profileVisibility" "profile_visibility" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "clientPreferences" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "user_settings"
SET "clientPreferences" = "extendedSettings"
WHERE "extendedSettings" IS NOT NULL
  AND "extendedSettings" != '{}'::jsonb;--> statement-breakpoint
UPDATE "user_settings"
SET "whoCanDm" = ("extendedSettings"->>'whoCanDm')::"dm_privacy"
WHERE "extendedSettings"->>'whoCanDm' IN ('everyone', 'friends', 'nobody');--> statement-breakpoint
UPDATE "user_settings"
SET "profileVisibility" = ("extendedSettings"->>'profileVisibility')::"profile_visibility"
WHERE "extendedSettings"->>'profileVisibility' IN ('everyone', 'friends', 'nobody');