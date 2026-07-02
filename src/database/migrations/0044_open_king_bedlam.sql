ALTER TABLE "posts" ADD COLUMN "scheduledFor" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "post_scheduled_for_idx" ON "posts" USING btree ("scheduledFor");