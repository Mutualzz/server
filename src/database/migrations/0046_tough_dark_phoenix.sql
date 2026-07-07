ALTER TABLE "posts" ADD COLUMN "embeds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "expressionIds" bigint[] DEFAULT '{}' NOT NULL;