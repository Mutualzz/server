CREATE TYPE "public"."theme_style" AS ENUM('normal', 'gradient');--> statement-breakpoint
CREATE TYPE "public"."theme_type" AS ENUM('light', 'dark');--> statement-breakpoint
CREATE TYPE "public"."default_avatar" AS ENUM('cat', 'dog', 'dragon', 'fox', 'hyena', 'rabbit', 'raccoon', 'wolf');--> statement-breakpoint
CREATE TYPE "public"."preferred_mode" AS ENUM('spaces', 'feed');--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ownerId" text NOT NULL,
	"description" text,
	"icon" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"spaceId" text NOT NULL,
	"userId" text NOT NULL,
	"nickname" text,
	"avatar" text,
	"banner" text,
	"roles" text[] DEFAULT '{}' NOT NULL,
	"joined" timestamp DEFAULT now() NOT NULL,
	"updated" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_spaceId_userId_pk" PRIMARY KEY("spaceId","userId")
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"authorId" text NOT NULL,
	"type" "theme_type" NOT NULL,
	"style" "theme_style" NOT NULL,
	"adaptive" boolean NOT NULL,
	"colors" jsonb NOT NULL,
	"typography" jsonb NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"accentColor" text NOT NULL,
	"globalName" text,
	"defaultAvatar" "default_avatar" NOT NULL,
	"avatar" text,
	"previousAvatars" text[] DEFAULT '{}' NOT NULL,
	"dateOfBirth" date NOT NULL,
	"hash" text NOT NULL,
	"created" timestamp DEFAULT now() NOT NULL,
	"updated" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user" text NOT NULL,
	"currentTheme" text DEFAULT 'baseDark' NOT NULL,
	"preferredMode" "preferred_mode" DEFAULT 'spaces' NOT NULL,
	"spacePositions" text[] DEFAULT '{}' NOT NULL,
	"updated" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_authorId_users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_users_id_fk" FOREIGN KEY ("user") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;