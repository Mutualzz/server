CREATE TABLE "bridge_ban_servers" (
	"banId" bigint NOT NULL,
	"serverId" text NOT NULL,
	"appliedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_ban_servers_banId_serverId_pk" PRIMARY KEY("banId","serverId")
);
--> statement-breakpoint
ALTER TABLE "bridge_bans" ADD COLUMN "liftedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bridge_ban_servers" ADD CONSTRAINT "bridge_ban_servers_banId_bridge_bans_id_fk" FOREIGN KEY ("banId") REFERENCES "public"."bridge_bans"("id") ON DELETE cascade ON UPDATE no action;