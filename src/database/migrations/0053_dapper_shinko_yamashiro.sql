ALTER TABLE "staff_actions" DROP CONSTRAINT "staff_actions_targetId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "staff_actions" ALTER COLUMN "targetId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_actions" ADD CONSTRAINT "staff_actions_targetId_users_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;