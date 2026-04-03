CREATE TABLE "emojis" (
	"id" bigint PRIMARY KEY NOT NULL,
	"type" smallint NOT NULL,
	"name" text NOT NULL,
	"authorId" bigint NOT NULL,
	"spaceId" bigint,
	"animated" boolean NOT NULL,
	"flags" bigint DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emojis" ADD CONSTRAINT "emojis_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emojis" ADD CONSTRAINT "emojis_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expression_space_id_idx" ON "emojis" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "expression_author_id_idx" ON "emojis" USING btree ("authorId");--> statement-breakpoint
CREATE INDEX "expression_type_idx" ON "emojis" USING btree ("type");--> statement-breakpoint
CREATE INDEX "expression_animated_idx" ON "emojis" USING btree ("animated");