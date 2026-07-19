ALTER TABLE "channels" ADD COLUMN "lastMessageId" bigint;
--> statement-breakpoint
CREATE INDEX "channel_last_message_id_idx" ON "channels" USING btree ("lastMessageId");
--> statement-breakpoint
UPDATE "channels" AS c
SET "lastMessageId" = (
	SELECT max(m."id")
	FROM "messages" AS m
	WHERE m."channelId" = c."id"
);
