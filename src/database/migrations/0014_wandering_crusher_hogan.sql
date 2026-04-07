ALTER TABLE "expressions" drop column "animated";--> statement-breakpoint
ALTER TABLE "expressions" ADD COLUMN "animated" boolean GENERATED ALWAYS AS (LEFT("assetHash", 2) = 'a_') STORED;