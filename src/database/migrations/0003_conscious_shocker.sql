ALTER TABLE "space_member_roles" RENAME COLUMN "id" TO "roleId";--> statement-breakpoint
ALTER TABLE "space_member_roles" DROP CONSTRAINT "space_member_roles_id_roles_id_fk";
--> statement-breakpoint
DROP INDEX "smr_role_id_idx";--> statement-breakpoint
ALTER TABLE "space_member_roles" DROP CONSTRAINT "space_member_roles_spaceId_userId_id_pk";--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "space_member_roles_spaceId_userId_roleId_pk" PRIMARY KEY("spaceId","userId","roleId");--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "space_member_roles_roleId_roles_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "smr_role_id_idx" ON "space_member_roles" USING btree ("roleId");