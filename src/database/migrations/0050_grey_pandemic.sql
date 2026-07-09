CREATE TABLE "staff_notes" (
	"id" bigint PRIMARY KEY NOT NULL,
	"targetId" bigint NOT NULL,
	"authorId" bigint NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_notes" ADD CONSTRAINT "staff_notes_targetId_users_id_fk" FOREIGN KEY ("targetId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_notes" ADD CONSTRAINT "staff_notes_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "staff_note_target_id_idx" ON "staff_notes" USING btree ("targetId");