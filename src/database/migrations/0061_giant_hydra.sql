CREATE TABLE "bridge_voice_bindings" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"serverId" text NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"spaceId" bigint NOT NULL,
	"channelId" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_voice_bindings" ADD CONSTRAINT "bridge_voice_bindings_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_voice_binding_bridge_id_idx" ON "bridge_voice_bindings" USING btree ("bridgeId");--> statement-breakpoint
CREATE INDEX "bridge_voice_binding_server_idx" ON "bridge_voice_bindings" USING btree ("bridgeId","serverId");--> statement-breakpoint
CREATE INDEX "bridge_voice_binding_room_idx" ON "bridge_voice_bindings" USING btree ("bridgeId","serverId","name");--> statement-breakpoint
CREATE INDEX "bridge_voice_binding_channel_idx" ON "bridge_voice_bindings" USING btree ("channelId");