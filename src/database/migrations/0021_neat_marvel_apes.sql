CREATE TABLE "space_bans" (
	"spaceId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"bannedBy" bigint NOT NULL,
	"reason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "space_bans_spaceId_userId_pk" PRIMARY KEY("spaceId","userId")
);
--> statement-breakpoint
ALTER TABLE "space_bans" ADD CONSTRAINT "space_bans_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "space_bans" ADD CONSTRAINT "space_bans_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "space_bans" ADD CONSTRAINT "space_bans_bannedBy_users_id_fk" FOREIGN KEY ("bannedBy") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;