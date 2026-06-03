CREATE TABLE "read_states" (
	"userId" bigint NOT NULL,
	"channelId" bigint NOT NULL,
	"type" smallint DEFAULT 0 NOT NULL,
	"lastMessageId" bigint,
	"notificationsCursor" bigint,
	"lastAckedId" bigint,
	"mentionCount" integer DEFAULT 0 NOT NULL,
	"lastPinTimestamp" timestamp with time zone,
	"badgeCount" integer DEFAULT 0 NOT NULL,
	"flags" bigint DEFAULT 0 NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;