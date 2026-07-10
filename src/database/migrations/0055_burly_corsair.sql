CREATE TABLE "support_tickets" (
	"id" bigint PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"platform" text,
	"appVersion" text,
	"assignedToId" bigint,
	"lastMessageAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"closedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" bigint PRIMARY KEY NOT NULL,
	"ticketId" bigint NOT NULL,
	"authorId" bigint NOT NULL,
	"body" text NOT NULL,
	"isStaff" boolean NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignedToId_users_id_fk" FOREIGN KEY ("assignedToId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticketId_support_tickets_id_fk" FOREIGN KEY ("ticketId") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "support_ticket_user_id_idx" ON "support_tickets" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "support_ticket_status_idx" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "support_ticket_last_message_at_idx" ON "support_tickets" USING btree ("lastMessageAt");--> statement-breakpoint
CREATE INDEX "support_message_ticket_id_idx" ON "support_messages" USING btree ("ticketId");