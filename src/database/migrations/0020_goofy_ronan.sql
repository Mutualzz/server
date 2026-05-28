CREATE TABLE "voice_moderation" (
	"spaceId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"spaceMute" boolean DEFAULT false NOT NULL,
	"spaceDeaf" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_moderation_spaceId_userId_pk" PRIMARY KEY("spaceId","userId")
);
--> statement-breakpoint
ALTER TABLE "voice_moderation" ADD CONSTRAINT "voice_moderation_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_moderation" ADD CONSTRAINT "voice_moderation_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_moderation_space_id_idx" ON "voice_moderation" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "voice_moderation_user_id_idx" ON "voice_moderation" USING btree ("userId");