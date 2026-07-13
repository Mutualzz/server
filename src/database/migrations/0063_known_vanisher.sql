CREATE TABLE "bridge_members" (
	"bridgeId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"joinedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_members_bridgeId_userId_pk" PRIMARY KEY("bridgeId","userId")
);
--> statement-breakpoint
ALTER TABLE "bridge_members" ADD CONSTRAINT "bridge_members_bridgeId_bridges_id_fk" FOREIGN KEY ("bridgeId") REFERENCES "public"."bridges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bridge_members" ADD CONSTRAINT "bridge_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bridge_member_user_id_idx" ON "bridge_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "bridge_member_bridge_id_idx" ON "bridge_members" USING btree ("bridgeId");