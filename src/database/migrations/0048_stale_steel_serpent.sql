CREATE TABLE "staff_actions" (
	"id" bigint PRIMARY KEY NOT NULL,
	"actorId" bigint NOT NULL,
	"targetId" bigint NOT NULL,
	"action" text NOT NULL,
	"reason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_actions" ADD CONSTRAINT "staff_actions_actorId_users_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_actions" ADD CONSTRAINT "staff_actions_targetId_users_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "staff_action_target_id_idx" ON "staff_actions" USING btree ("targetId");