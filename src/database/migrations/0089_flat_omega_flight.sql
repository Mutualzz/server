CREATE TABLE "message_reminders" (
	"userId" bigint NOT NULL,
	"messageId" bigint NOT NULL,
	"channelId" bigint NOT NULL,
	"remindAt" timestamp with time zone NOT NULL,
	"firedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_reminders" ADD CONSTRAINT "message_reminders_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reminders" ADD CONSTRAINT "message_reminders_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reminders" ADD CONSTRAINT "message_reminders_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reminders_uq" ON "message_reminders" USING btree ("userId","messageId");--> statement-breakpoint
CREATE INDEX "message_reminders_user_remind_at_idx" ON "message_reminders" USING btree ("userId","remindAt");--> statement-breakpoint
CREATE INDEX "message_reminders_pending_idx" ON "message_reminders" USING btree ("remindAt") WHERE "message_reminders"."firedAt" is null;