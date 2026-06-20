CREATE TABLE "message_reactions" (
	"id" bigint PRIMARY KEY NOT NULL,
	"messageId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"unicode" text,
	"expressionId" bigint,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_expressionId_expressions_id_fk" FOREIGN KEY ("expressionId") REFERENCES "public"."expressions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reactions_unicode_uq" ON "message_reactions" USING btree ("messageId","userId","unicode") WHERE "message_reactions"."expressionId" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_reactions_expression_uq" ON "message_reactions" USING btree ("messageId","userId","expressionId") WHERE "message_reactions"."unicode" is null;--> statement-breakpoint
CREATE INDEX "message_reactions_message_id_idx" ON "message_reactions" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX "message_reactions_expression_id_idx" ON "message_reactions" USING btree ("expressionId");