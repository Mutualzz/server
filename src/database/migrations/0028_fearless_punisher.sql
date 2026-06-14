CREATE TABLE "channel_member_overwrites" (
	"channelId" bigint NOT NULL,
	"spaceId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_member_overwrites_channelId_userId_pk" PRIMARY KEY("channelId","userId")
);
--> statement-breakpoint
CREATE TABLE "channel_role_overwrites" (
	"channelId" bigint NOT NULL,
	"spaceId" bigint NOT NULL,
	"roleId" bigint NOT NULL,
	"allow" bigint DEFAULT 0 NOT NULL,
	"deny" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_role_overwrites_channelId_roleId_pk" PRIMARY KEY("channelId","roleId")
);
--> statement-breakpoint
DROP TABLE "channel_permission_overwrites" CASCADE;--> statement-breakpoint
ALTER TABLE "channel_member_overwrites" ADD CONSTRAINT "channel_member_overwrites_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member_overwrites" ADD CONSTRAINT "channel_member_overwrites_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member_overwrites" ADD CONSTRAINT "channel_member_overwrites_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_role_overwrites" ADD CONSTRAINT "channel_role_overwrites_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_role_overwrites" ADD CONSTRAINT "channel_role_overwrites_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_role_overwrites" ADD CONSTRAINT "channel_role_overwrites_roleId_roles_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cmo_channel_id_idx" ON "channel_member_overwrites" USING btree ("channelId");--> statement-breakpoint
CREATE INDEX "cmo_space_id_idx" ON "channel_member_overwrites" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "cmo_user_id_idx" ON "channel_member_overwrites" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "cro_channel_id_idx" ON "channel_role_overwrites" USING btree ("channelId");--> statement-breakpoint
CREATE INDEX "cro_space_id_idx" ON "channel_role_overwrites" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "cro_role_id_idx" ON "channel_role_overwrites" USING btree ("roleId");