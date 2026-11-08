CREATE TABLE "message_bookmarks" (
	"userId" bigint NOT NULL,
	"messageId" bigint NOT NULL,
	"channelId" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_bookmarks" ADD CONSTRAINT "message_bookmarks_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_bookmarks" ADD CONSTRAINT "message_bookmarks_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_bookmarks" ADD CONSTRAINT "message_bookmarks_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_bookmarks_uq" ON "message_bookmarks" USING btree ("userId","messageId");--> statement-breakpoint
CREATE INDEX "message_bookmarks_user_created_idx" ON "message_bookmarks" USING btree ("userId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_bookmarks_message_id_idx" ON "message_bookmarks" USING btree ("messageId");