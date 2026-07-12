CREATE TABLE "bridge_read_states" (
	"userId" bigint NOT NULL,
	"bridgeId" bigint NOT NULL,
	"lastAckedId" text DEFAULT '' NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_read_states_userId_bridgeId_pk" PRIMARY KEY("userId","bridgeId")
);
--> statement-breakpoint
ALTER TABLE "bridge_messages" ALTER COLUMN "content" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "bridge_messages" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_minecraft_servers" ADD COLUMN "lastSeenAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bridges" ADD COLUMN "lastMessageId" text;--> statement-breakpoint
ALTER TABLE "bridge_read_states" ADD CONSTRAINT "bridge_read_states_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_read_states" ADD CONSTRAINT "bridge_read_states_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_read_state_bridge_id_idx" ON "bridge_read_states" USING btree ("bridgeId");