ALTER TABLE "space_bans" RENAME COLUMN "bannedBy" TO "bannedById";--> statement-breakpoint
ALTER TABLE "space_bans" DROP CONSTRAINT "space_bans_bannedBy_users_id_fk";
--> statement-breakpoint
ALTER TABLE "space_bans" ADD CONSTRAINT "space_bans_bannedById_users_id_fk" FOREIGN KEY ("bannedById") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;