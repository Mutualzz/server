ALTER TABLE "space_members" DROP CONSTRAINT "space_members_space_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE "space_members" DROP CONSTRAINT "space_members_user_users_id_fk";
--> statement-breakpoint
ALTER TABLE "space_members" ALTER COLUMN "joined" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "space_members" ALTER COLUMN "joined" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "space_members" ALTER COLUMN "updated" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "space_members" ALTER COLUMN "updated" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_spaces_id_fk" FOREIGN KEY ("space") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_users_id_fk" FOREIGN KEY ("user") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;