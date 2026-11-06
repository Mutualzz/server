CREATE TABLE "bridge_bans" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"minecraftUuid" text NOT NULL,
	"minecraftName" text NOT NULL,
	"reason" text,
	"bannedById" bigint,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_bans" ADD CONSTRAINT "bridge_bans_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_bans" ADD CONSTRAINT "bridge_bans_bannedById_users_id_fk" FOREIGN KEY ("bannedById") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bridge_ban_player_uq" ON "bridge_bans" USING btree ("bridgeId","minecraftUuid");