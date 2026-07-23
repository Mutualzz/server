CREATE TABLE "space_member_notification_settings" (
	"userId" bigint NOT NULL,
	"spaceId" bigint NOT NULL,
	"level" smallint DEFAULT 1 NOT NULL,
	"mutedUntil" timestamp with time zone,
	"suppressEveryone" boolean DEFAULT false NOT NULL,
	"suppressRoles" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_member_notification_settings_userId_spaceId_pk" PRIMARY KEY("userId","spaceId")
);
--> statement-breakpoint
ALTER TABLE "read_states" ADD COLUMN "notificationLevel" smallint;--> statement-breakpoint
ALTER TABLE "read_states" ADD COLUMN "mutedUntil" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "space_member_notification_settings" ADD CONSTRAINT "space_member_notification_settings_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_notification_settings" ADD CONSTRAINT "space_member_notification_settings_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;