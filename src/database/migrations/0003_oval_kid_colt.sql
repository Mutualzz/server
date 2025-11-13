ALTER TABLE "spaces" ADD COLUMN "flags" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "space_members" ADD COLUMN "flags" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "flags" bigint DEFAULT 0 NOT NULL;