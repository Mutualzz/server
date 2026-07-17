ALTER TABLE "spaces" ADD COLUMN "themeId" text;--> statement-breakpoint
ALTER TABLE "themes" ADD COLUMN "spaceId" bigint;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "theme_space_id_idx" ON "themes" USING btree ("spaceId");