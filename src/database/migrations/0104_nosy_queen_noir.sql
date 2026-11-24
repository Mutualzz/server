CREATE TABLE "message_mentions" (
	"targetId" bigint NOT NULL,
	"messageId" bigint NOT NULL,
	"type" text NOT NULL,
	"channelId" bigint NOT NULL,
	"spaceId" bigint,
	"authorId" bigint,
	CONSTRAINT "message_mentions_targetId_messageId_pk" PRIMARY KEY("targetId","messageId")
);
--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_mentions_message_id_idx" ON "message_mentions" USING btree ("messageId");