ALTER TABLE "post_comments" ADD COLUMN "embeds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "post_comments" ADD COLUMN "repliedToId" bigint;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_repliedToId_post_comments_id_fk" FOREIGN KEY ("repliedToId") REFERENCES "public"."post_comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_comment_replied_to_id_idx" ON "post_comments" USING btree ("repliedToId");