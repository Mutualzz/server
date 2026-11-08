CREATE TABLE "mention_dismissals" (
	"userId" bigint NOT NULL,
	"messageId" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mention_dismissals_userId_messageId_pk" PRIMARY KEY("userId","messageId")
);
--> statement-breakpoint
ALTER TABLE "mention_dismissals" ADD CONSTRAINT "mention_dismissals_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mention_dismissals" ADD CONSTRAINT "mention_dismissals_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_mentions_gin_idx" ON "messages" USING gin ("mentions");