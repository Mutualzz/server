ALTER TABLE "spaces" RENAME COLUMN "ownerId" TO "owner";--> statement-breakpoint
ALTER TABLE "space_members" RENAME COLUMN "spaceId" TO "space";--> statement-breakpoint
ALTER TABLE "space_members" RENAME COLUMN "userId" TO "user";--> statement-breakpoint
ALTER TABLE "themes" RENAME COLUMN "authorId" TO "author";--> statement-breakpoint
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_ownerId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "space_members" DROP CONSTRAINT "space_members_spaceId_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE "space_members" DROP CONSTRAINT "space_members_userId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "themes" DROP CONSTRAINT "themes_authorId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "space_members" DROP CONSTRAINT "space_members_spaceId_userId_pk";--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_user_pk" PRIMARY KEY("space","user");--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_users_id_fk" FOREIGN KEY ("owner") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_spaces_id_fk" FOREIGN KEY ("space") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_users_id_fk" FOREIGN KEY ("user") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_author_users_id_fk" FOREIGN KEY ("author") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;