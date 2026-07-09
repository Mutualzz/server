CREATE TABLE "appeals" (
	"id" bigint PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"staffResponse" text,
	"reviewedById" bigint,
	"reviewedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "restrictedUntil" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "restrictionReason" text;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_reviewedById_users_id_fk" FOREIGN KEY ("reviewedById") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "appeal_user_id_idx" ON "appeals" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "appeal_status_idx" ON "appeals" USING btree ("status");