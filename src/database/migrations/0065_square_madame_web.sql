CREATE TABLE "user_spotify_connections" (
	"userId" bigint PRIMARY KEY NOT NULL,
	"spotifyUserId" text NOT NULL,
	"displayName" text,
	"externalUrl" text,
	"accessToken" text NOT NULL,
	"refreshToken" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"shareSpotify" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_spotify_connections" ADD CONSTRAINT "user_spotify_connections_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;