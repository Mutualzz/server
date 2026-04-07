ALTER TABLE "emojis" RENAME TO "expressions";--> statement-breakpoint
ALTER TABLE "expressions" DROP CONSTRAINT "emojis_authorId_users_id_fk";
--> statement-breakpoint
ALTER TABLE "expressions" DROP CONSTRAINT "emojis_spaceId_spaces_id_fk";
--> statement-breakpoint
ALTER TABLE "expressions" ADD COLUMN "assetHash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "expressions" ADD CONSTRAINT "expressions_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expressions" ADD CONSTRAINT "expressions_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;