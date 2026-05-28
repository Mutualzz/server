CREATE TABLE "channel_recipients" (
	"channelId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_recipients_channelId_userId_pk" PRIMARY KEY("channelId","userId")
);
--> statement-breakpoint
ALTER TABLE "channel_recipients" ADD CONSTRAINT "channel_recipients_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_recipients" ADD CONSTRAINT "channel_recipients_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cr_channel_id_idx" ON "channel_recipients" USING btree ("channelId");--> statement-breakpoint
CREATE INDEX "cr_user_id_idx" ON "channel_recipients" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "cr_closed_idx" ON "channel_recipients" USING btree ("userId","closed");