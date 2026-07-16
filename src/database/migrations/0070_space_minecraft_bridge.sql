CREATE TABLE IF NOT EXISTS "bridge_messages" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"sourceKey" text NOT NULL,
	"serverId" text NOT NULL,
	"source" text NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"name" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"uuid" text,
	"userId" text,
	"avatarUrl" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_messages_sourceKey_unique" UNIQUE("sourceKey")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bridge_messages" ADD CONSTRAINT "bridge_messages_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_message_bridge_id_idx" ON "bridge_messages" USING btree ("bridgeId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_message_bridge_created_at_idx" ON "bridge_messages" USING btree ("bridgeId","createdAt");--> statement-breakpoint
ALTER TABLE "bridges" DROP CONSTRAINT IF EXISTS "bridges_ownerId_users_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "bridge_voice_binding_channel_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "bridge_owner_id_idx";--> statement-breakpoint
ALTER TABLE "bridge_minecraft_servers" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN IF NOT EXISTS "spaceId" bigint;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN IF NOT EXISTS "createdById" bigint;--> statement-breakpoint
DELETE FROM "bridges" WHERE "spaceId" IS NULL OR "createdById" IS NULL;--> statement-breakpoint
ALTER TABLE "bridges" ALTER COLUMN "spaceId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bridges" ALTER COLUMN "createdById" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bridges" ADD CONSTRAINT "bridges_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bridges" ADD CONSTRAINT "bridges_createdById_users_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridges_space_id_uq" ON "bridges" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridges_created_by_id_idx" ON "bridges" USING btree ("createdById");--> statement-breakpoint
ALTER TABLE "bridges" DROP COLUMN IF EXISTS "ownerId";
