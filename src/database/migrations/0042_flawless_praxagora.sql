CREATE TABLE "posts" (
	"id" bigint PRIMARY KEY NOT NULL,
	"authorId" bigint NOT NULL,
	"content" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hashtags" (
	"id" bigint PRIMARY KEY NOT NULL,
	"tag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_hashtags" (
	"postId" bigint NOT NULL,
	"hashtagId" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_comments" (
	"id" bigint PRIMARY KEY NOT NULL,
	"postId" bigint NOT NULL,
	"authorId" bigint NOT NULL,
	"content" text NOT NULL,
	"expressionIds" bigint[] DEFAULT '{}' NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_postId_posts_id_fk" FOREIGN KEY ("postId") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_hashtags" ADD CONSTRAINT "post_hashtags_hashtagId_hashtags_id_fk" FOREIGN KEY ("hashtagId") REFERENCES "public"."hashtags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_postId_posts_id_fk" FOREIGN KEY ("postId") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_author_id_idx" ON "posts" USING btree ("authorId");--> statement-breakpoint
CREATE INDEX "post_created_at_idx" ON "posts" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "hashtag_tag_uq" ON "hashtags" USING btree ("tag");--> statement-breakpoint
CREATE UNIQUE INDEX "post_hashtag_uq" ON "post_hashtags" USING btree ("postId","hashtagId");--> statement-breakpoint
CREATE INDEX "post_hashtag_hashtag_id_idx" ON "post_hashtags" USING btree ("hashtagId");--> statement-breakpoint
CREATE INDEX "post_comment_post_id_idx" ON "post_comments" USING btree ("postId");--> statement-breakpoint
CREATE INDEX "post_comment_post_id_created_at_idx" ON "post_comments" USING btree ("postId","createdAt");