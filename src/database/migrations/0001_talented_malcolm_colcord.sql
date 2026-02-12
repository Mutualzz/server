ALTER TABLE "space_member_roles" DROP CONSTRAINT "smr_space_member_fkey";
--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "smr_space_member_fkey" FOREIGN KEY ("spaceId","userId") REFERENCES "public"."space_members"("spaceId","userId") ON DELETE cascade ON UPDATE no action;