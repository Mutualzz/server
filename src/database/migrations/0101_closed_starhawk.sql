DROP INDEX "message_channel_id_idx";--> statement-breakpoint
DROP INDEX "message_channel_created_at_idx";--> statement-breakpoint
CREATE INDEX "message_channel_id_id_idx" ON "messages" USING btree ("channelId","id");