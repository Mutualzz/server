CREATE TABLE "minecraft_inventories" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"serverId" text NOT NULL,
	"minecraftUuid" text NOT NULL,
	"minecraftName" text NOT NULL,
	"inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enderChest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capturedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "minecraft_inventories" ADD CONSTRAINT "minecraft_inventories_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "minecraft_inventory_player_uq" ON "minecraft_inventories" USING btree ("bridgeId","serverId","minecraftUuid");
