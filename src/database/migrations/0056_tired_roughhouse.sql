ALTER TABLE "appeals" ADD COLUMN "spaceId" bigint;--> statement-breakpoint
ALTER TABLE "appeals" ADD CONSTRAINT "appeals_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "appeal_space_id_idx" ON "appeals" USING btree ("spaceId");