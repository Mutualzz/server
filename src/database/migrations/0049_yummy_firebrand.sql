CREATE TABLE "reports" (
	"id" bigint PRIMARY KEY NOT NULL,
	"reporterId" bigint NOT NULL,
	"targetType" text NOT NULL,
	"targetId" bigint NOT NULL,
	"reason" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewedById" bigint,
	"reviewedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporterId_users_id_fk" FOREIGN KEY ("reporterId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reviewedById_users_id_fk" FOREIGN KEY ("reviewedById") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "report_target_idx" ON "reports" USING btree ("targetType","targetId");--> statement-breakpoint
CREATE INDEX "report_status_idx" ON "reports" USING btree ("status");