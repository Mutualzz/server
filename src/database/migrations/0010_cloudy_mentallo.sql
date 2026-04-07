ALTER TABLE "expressions" ALTER COLUMN "animated" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "expressions" drop column "animated";--> statement-breakpoint
ALTER TABLE "expressions" ADD COLUMN "animated" boolean GENERATED ALWAYS AS ('assetHash' LIKE 'a_%') STORED;