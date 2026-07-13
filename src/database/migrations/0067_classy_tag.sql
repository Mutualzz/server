CREATE TABLE "user_activity_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"applicationId" text,
	"details" text,
	"state" text,
	"url" text,
	"assets" jsonb,
	"startedAt" timestamp,
	"endedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_activity_history" ADD CONSTRAINT "user_activity_history_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "user_activity_history_user_ended_idx" ON "user_activity_history" USING btree ("userId","endedAt");