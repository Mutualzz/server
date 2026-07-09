ALTER TABLE "user_settings" ADD COLUMN "pushEnabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "pushDirectMessages" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "pushMentions" boolean DEFAULT true NOT NULL;