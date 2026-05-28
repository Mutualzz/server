ALTER TABLE "channels" DROP CONSTRAINT "channels_lastMessageId_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "recipientIds";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "lastMessageId";