CREATE TABLE "scheduled_messages" (
	"id" bigint PRIMARY KEY NOT NULL,
	"authorId" bigint NOT NULL,
	"channelId" bigint NOT NULL,
	"content" text,
	"repliedToId" bigint,
	"mentionReply" boolean DEFAULT true NOT NULL,
	"expressionIds" bigint[] DEFAULT '{}' NOT NULL,
	"sharedPostId" bigint,
	"codedLinks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduledFor" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failureReason" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_messages_author_scheduled_for_idx" ON "scheduled_messages" USING btree ("authorId","scheduledFor");--> statement-breakpoint
CREATE INDEX "scheduled_messages_due_idx" ON "scheduled_messages" USING btree ("scheduledFor") WHERE "scheduled_messages"."status" = 'pending';