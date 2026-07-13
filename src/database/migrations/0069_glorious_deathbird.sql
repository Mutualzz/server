CREATE TABLE "changelogs" (
	"id" bigint PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"imageUrl" text,
	"authorId" bigint NOT NULL,
	"desktopVersion" text,
	"mobileVersion" text,
	"publishedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "lastSeenChangelogId" bigint;--> statement-breakpoint
ALTER TABLE "changelogs" ADD CONSTRAINT "changelogs_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE IN`DEX "changelog_author_id_idx" ON "changelogs" USING btree ("authorId");--> statement-breakpoint
CREATE INDEX "changelog_published_at_idx" ON "changelogs" USING btree ("publishedAt");--> statement-breakpoint
CREATE INDEX "changelog_desktop_version_idx" ON "changelogs" USING btree ("desktopVersion");--> statement-breakpoint
CREATE INDEX "changelog_mobile_version_idx" ON "changelogs" USING btree ("mobileVersion");