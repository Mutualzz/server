CREATE TABLE IF NOT EXISTS "appeals" (
	"id" bigint PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"spaceId" bigint,
	"message" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"staffResponse" text,
	"reviewedById" bigint,
	"reviewedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeals" ADD CONSTRAINT "appeals_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeals" ADD CONSTRAINT "appeals_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appeals" ADD CONSTRAINT "appeals_reviewedById_users_id_fk" FOREIGN KEY ("reviewedById") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appeal_user_id_idx" ON "appeals" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appeal_space_id_idx" ON "appeals" USING btree ("spaceId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appeal_status_idx" ON "appeals" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "appeals" ADD COLUMN IF NOT EXISTS "spaceId" bigint;
