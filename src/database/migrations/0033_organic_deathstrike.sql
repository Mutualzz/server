CREATE TABLE "user_profiles" (
	"userId" bigint PRIMARY KEY NOT NULL,
	"configured" boolean DEFAULT false NOT NULL,
	"backgroundColor" text,
	"backgroundImage" text,
	"banner" text,
	"bio" text,
	"introMusic" jsonb,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;