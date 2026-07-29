ALTER TABLE "users" ADD COLUMN "discordId" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pinnedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pinnedBy" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pinnedBy_users_id_fk" FOREIGN KEY ("pinnedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_discord_id_idx" ON "users" USING btree ("discordId") WHERE "users"."discordId" is not null;--> statement-breakpoint
CREATE INDEX "message_channel_pinned_idx" ON "messages" USING btree ("channelId","pinnedAt") WHERE "messages"."pinned" = true;