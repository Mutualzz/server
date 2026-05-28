CREATE TABLE "relationships" (
	"id" bigint PRIMARY KEY NOT NULL,
	"userId" bigint NOT NULL,
	"otherUserId" bigint NOT NULL,
	"type" smallint NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_otherUserId_users_id_fk" FOREIGN KEY ("otherUserId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_user_other_uq" ON "relationships" USING btree ("userId","otherUserId");--> statement-breakpoint
CREATE INDEX "relationships_user_id_idx" ON "relationships" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "relationships_other_user_id_idx" ON "relationships" USING btree ("otherUserId");--> statement-breakpoint
CREATE INDEX "relationships_type_idx" ON "relationships" USING btree ("type");