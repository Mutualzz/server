CREATE TABLE "user_connections" (
	"userId" bigint NOT NULL,
	"provider" text NOT NULL,
	"providerUserId" text NOT NULL,
	"displayName" text,
	"externalUrl" text,
	"accessToken" text,
	"refreshToken" text,
	"expiresAt" timestamp,
	"shareOnProfile" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_connections_userId_provider_pk" PRIMARY KEY("userId","provider")
);
--> statement-breakpoint
ALTER TABLE "user_connections" ADD CONSTRAINT "user_connections_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "user_connections_provider_user_uidx" ON "user_connections" USING btree ("provider","providerUserId");