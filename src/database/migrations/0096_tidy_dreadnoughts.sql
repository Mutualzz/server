CREATE TABLE "user_profile_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"savedAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profile_versions" ADD CONSTRAINT "user_profile_versions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "user_profile_versions_user_saved_idx" ON "user_profile_versions" USING btree ("userId","savedAt");