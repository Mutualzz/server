CREATE TABLE "minecraft_inventory_edits" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"serverId" text NOT NULL,
	"minecraftUuid" text NOT NULL,
	"op" jsonb NOT NULL,
	"expected" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"createdById" bigint,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"resolvedAt" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bridge_minecraft_servers" ADD COLUMN "remoteInventoryEdit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "minecraft_inventory_edits" ADD CONSTRAINT "minecraft_inventory_edits_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minecraft_inventory_edits" ADD CONSTRAINT "minecraft_inventory_edits_createdById_users_id_fk" FOREIGN KEY ("createdById") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "minecraft_inventory_edit_player_idx" ON "minecraft_inventory_edits" USING btree ("bridgeId","serverId","minecraftUuid","status");