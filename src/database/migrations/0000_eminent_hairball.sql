CREATE TYPE "public"."theme_style" AS ENUM('normal', 'gradient');--> statement-breakpoint
CREATE TYPE "public"."theme_type" AS ENUM('light', 'dark');--> statement-breakpoint
CREATE TYPE "public"."preferred_mode" AS ENUM('spaces', 'feed');--> statement-breakpoint
CREATE TABLE "channels" (
	"id" bigint PRIMARY KEY NOT NULL,
	"type" smallint NOT NULL,
	"spaceId" bigint,
	"name" text,
	"ownerId" bigint,
	"topic" text,
	"position" smallint DEFAULT 0 NOT NULL,
	"parentId" bigint,
	"recipientIds" bigint[],
	"nsfw" boolean DEFAULT false NOT NULL,
	"lastMessageId" bigint,
	"flags" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"type" smallint NOT NULL,
	"code" text PRIMARY KEY NOT NULL,
	"spaceId" bigint,
	"channelId" bigint,
	"userId" bigint,
	"inviterId" bigint NOT NULL,
	"maxUses" smallint DEFAULT 0 NOT NULL,
	"uses" smallint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"spaceId" bigint NOT NULL,
	"hoist" boolean DEFAULT false NOT NULL,
	"permissions" bigint DEFAULT 0 NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"color" text DEFAULT '#99958e' NOT NULL,
	"mentionable" boolean DEFAULT false NOT NULL,
	"flags" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ownerId" bigint NOT NULL,
	"description" text,
	"icon" text,
	"vanityCode" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"flags" bigint DEFAULT 0 NOT NULL,
	"memberCount" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "spaces_vanityCode_unique" UNIQUE("vanityCode")
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"spaceId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"nickname" text,
	"avatar" text,
	"banner" text,
	"flags" bigint DEFAULT 0 NOT NULL,
	"joinedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_spaceId_userId_pk" PRIMARY KEY("spaceId","userId")
);
--> statement-breakpoint
CREATE TABLE "space_member_roles" (
	"id" bigint NOT NULL,
	"spaceId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"assignedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_member_roles_spaceId_userId_id_pk" PRIMARY KEY("spaceId","userId","id")
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"authorId" bigint NOT NULL,
	"type" "theme_type" NOT NULL,
	"style" "theme_style" NOT NULL,
	"adaptive" boolean NOT NULL,
	"colors" jsonb NOT NULL,
	"typography" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"accentColor" text NOT NULL,
	"globalName" text,
	"defaultAvatar" jsonb NOT NULL,
	"avatar" text,
	"previousAvatars" text[] DEFAULT '{}' NOT NULL,
	"dateOfBirth" date NOT NULL,
	"hash" text NOT NULL,
	"flags" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"userId" bigint PRIMARY KEY NOT NULL,
	"currentTheme" text,
	"currentIcon" text,
	"preferredMode" "preferred_mode" DEFAULT 'spaces' NOT NULL,
	"spacePositions" bigint[] DEFAULT '{}' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigint PRIMARY KEY NOT NULL,
	"type" smallint DEFAULT 0 NOT NULL,
	"authorId" bigint NOT NULL,
	"channelId" bigint NOT NULL,
	"spaceId" bigint,
	"content" text,
	"edited" boolean DEFAULT false NOT NULL,
	"embeds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"nonce" bigint,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_parentId_channels_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_lastMessageId_messages_id_fk" FOREIGN KEY ("lastMessageId") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviterId_users_id_fk" FOREIGN KEY ("inviterId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "space_member_roles_id_roles_id_fk" FOREIGN KEY ("id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "space_member_roles_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "smr_space_member_fkey" FOREIGN KEY ("spaceId","userId") REFERENCES "public"."space_members"("spaceId","userId") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channelId_channels_id_fk" FOREIGN KEY ("channelId") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_space_id_idx" ON "channels" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "channel_owner_id_idx" ON "channels" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "channel_parent_id_idx" ON "channels" USING btree ("parentId");--> statement-breakpoint
CREATE INDEX "channel_created_at_idx" ON "channels" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "channel_type_idx" ON "channels" USING btree ("type");--> statement-breakpoint
CREATE INDEX "invite_code_idx" ON "invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "invite_type_idx" ON "invites" USING btree ("type");--> statement-breakpoint
CREATE INDEX "invite_space_id_idx" ON "invites" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "invite_channel_id_idx" ON "invites" USING btree ("channelId");--> statement-breakpoint
CREATE INDEX "invite_user_id_idx" ON "invites" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "invite_inviter_id_idx" ON "invites" USING btree ("inviterId");--> statement-breakpoint
CREATE INDEX "idx_invites_reuse" ON "invites" USING btree ("spaceId","channelId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "roles_space_id_idx" ON "roles" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "roles_position_idx" ON "roles" USING btree ("position");--> statement-breakpoint
CREATE INDEX "roles_created_at_idx" ON "roles" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "space_owner_id_idx" ON "spaces" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "space_created_at_idx" ON "spaces" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "space_members_space_id_idx" ON "space_members" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "space_members_user_id_idx" ON "space_members" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "space_members_joined_at_idx" ON "space_members" USING btree ("joinedAt");--> statement-breakpoint
CREATE INDEX "smr_space_id_idx" ON "space_member_roles" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "smr_user_id_idx" ON "space_member_roles" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "smr_role_id_idx" ON "space_member_roles" USING btree ("id");--> statement-breakpoint
CREATE INDEX "theme_author_id_idx" ON "themes" USING btree ("authorId");--> statement-breakpoint
CREATE INDEX "theme_type_idx" ON "themes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "theme_style_idx" ON "themes" USING btree ("style");--> statement-breakpoint
CREATE INDEX "theme_created_at_idx" ON "themes" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "user_created_at_idx" ON "users" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "message_channel_id_idx" ON "messages" USING btree ("channelId");--> statement-breakpoint
CREATE INDEX "message_created_at_idx" ON "messages" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "message_channel_created_at_idx" ON "messages" USING btree ("channelId","createdAt");

CREATE OR REPLACE FUNCTION assign_default_role()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO space_member_roles (spaceId, userId, id, assignedAt)
    VALUES (NEW.spaceId, NEW.userId, NEW.spaceId, NOW()); -- 12345 is your default role id
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_member_insert
AFTER INSERT ON space_members
FOR EACH ROW
EXECUTE FUNCTION assign_default_role();