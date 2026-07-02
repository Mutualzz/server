CREATE TABLE "post_likes" (
	"postId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_saves" (
	"postId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_shares" (
	"postId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_postId_posts_id_fk" FOREIGN KEY ("postId") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_saves" ADD CONSTRAINT "post_saves_postId_posts_id_fk" FOREIGN KEY ("postId") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_saves" ADD CONSTRAINT "post_saves_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_shares" ADD CONSTRAINT "post_shares_postId_posts_id_fk" FOREIGN KEY ("postId") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_shares" ADD CONSTRAINT "post_shares_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_like_uq" ON "post_likes" USING btree ("postId","userId");--> statement-breakpoint
CREATE INDEX "post_like_post_id_idx" ON "post_likes" USING btree ("postId");--> statement-breakpoint
CREATE INDEX "post_like_user_id_idx" ON "post_likes" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "post_save_uq" ON "post_saves" USING btree ("postId","userId");--> statement-breakpoint
CREATE INDEX "post_save_post_id_idx" ON "post_saves" USING btree ("postId");--> statement-breakpoint
CREATE INDEX "post_save_user_id_idx" ON "post_saves" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "post_share_uq" ON "post_shares" USING btree ("postId","userId");--> statement-breakpoint
CREATE INDEX "post_share_post_id_idx" ON "post_shares" USING btree ("postId");--> statement-breakpoint
CREATE INDEX "post_share_user_id_idx" ON "post_shares" USING btree ("userId");