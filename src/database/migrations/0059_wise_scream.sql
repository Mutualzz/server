CREATE TABLE "bridge_messages" (
	"id" bigint PRIMARY KEY NOT NULL,
	"bridgeId" bigint NOT NULL,
	"sourceKey" text NOT NULL,
	"serverId" text NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"uuid" text,
	"userId" text,
	"avatarUrl" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_messages_sourceKey_unique" UNIQUE("sourceKey")
);
--> statement-breakpoint
ALTER TABLE "bridge_messages" ADD CONSTRAINT "bridge_messages_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_message_bridge_id_idx" ON "bridge_messages" USING btree ("bridgeId");--> statement-breakpoint
CREATE INDEX "bridge_message_bridge_created_at_idx" ON "bridge_messages" USING btree ("bridgeId","createdAt");