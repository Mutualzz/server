ALTER TABLE "user_settings" ADD COLUMN "favoriteEmojis" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "favoriteGifs" text[] DEFAULT '{}' NOT NULL;