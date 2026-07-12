CREATE TABLE "bridge_discord_bindings" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"serverId" text NOT NULL,
	"guildId" text NOT NULL,
	"channelId" text NOT NULL,
	"webhookId" text,
	"webhookToken" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_minecraft_servers" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"serverId" text NOT NULL,
	"displayName" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bridge_tokens" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"tokenHash" text NOT NULL,
	"tokenPrefix" text NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"lastUsedAt" timestamp with time zone,
	"revokedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_tokens_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
CREATE TABLE "bridges" (
	"id" bigint PRIMARY KEY NOT NULL,
	"ownerId" bigint NOT NULL,
	"name" text NOT NULL,
	"status" smallint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "minecraft_link_codes" (
	"id" bigint PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"userId" bigint,
	"bridgeId" bigint,
	"minecraftUuid" uuid,
	"minecraftName" text,
	"discordId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"usedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "minecraft_link_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "minecraft_links" (
	"id" bigint PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"minecraftUuid" uuid NOT NULL,
	"minecraftName" text NOT NULL,
	"discordId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_discord_bindings" ADD CONSTRAINT "bridge_discord_bindings_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_minecraft_servers" ADD CONSTRAINT "bridge_minecraft_servers_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_tokens" ADD CONSTRAINT "bridge_tokens_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridges" ADD CONSTRAINT "bridges_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minecraft_link_codes" ADD CONSTRAINT "minecraft_link_codes_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minecraft_link_codes" ADD CONSTRAINT "minecraft_link_codes_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minecraft_links" ADD CONSTRAINT "minecraft_links_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_discord_binding_bridge_id_idx" ON "bridge_discord_bindings" USING btree ("bridgeId");--> statement-breakpoint
CREATE INDEX "bridge_discord_binding_channel_idx" ON "bridge_discord_bindings" USING btree ("channelId");--> statement-breakpoint
CREATE INDEX "bridge_discord_binding_server_idx" ON "bridge_discord_bindings" USING btree ("bridgeId","serverId");--> statement-breakpoint
CREATE INDEX "bridge_mc_server_bridge_id_idx" ON "bridge_minecraft_servers" USING btree ("bridgeId");--> statement-breakpoint
CREATE INDEX "bridge_mc_server_slug_idx" ON "bridge_minecraft_servers" USING btree ("bridgeId","serverId");--> statement-breakpoint
CREATE INDEX "bridge_token_bridge_id_idx" ON "bridge_tokens" USING btree ("bridgeId");--> statement-breakpoint
CREATE INDEX "bridge_token_hash_idx" ON "bridge_tokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "bridge_owner_id_idx" ON "bridges" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "bridge_status_idx" ON "bridges" USING btree ("status");--> statement-breakpoint
CREATE INDEX "minecraft_link_code_code_idx" ON "minecraft_link_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "minecraft_link_code_user_id_idx" ON "minecraft_link_codes" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "minecraft_link_code_expires_at_idx" ON "minecraft_link_codes" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "minecraft_link_user_id_uq" ON "minecraft_links" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "minecraft_link_uuid_uq" ON "minecraft_links" USING btree ("minecraftUuid");--> statement-breakpoint
CREATE INDEX "minecraft_link_discord_id_idx" ON "minecraft_links" USING btree ("discordId");