CREATE TABLE "space_member_roles" (
	"spaceId" bigint NOT NULL,
	"userId" bigint NOT NULL,
	"roleId" bigint NOT NULL,
	"assignedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_member_roles_spaceId_userId_roleId_pk" PRIMARY KEY("spaceId","userId","roleId")
);
--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "space_member_roles_spaceId_spaces_id_fk" FOREIGN KEY ("spaceId") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "space_member_roles_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_member_roles" ADD CONSTRAINT "space_member_roles_roleId_roles_id_fk" FOREIGN KEY ("roleId") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "smr_space_id_idx" ON "space_member_roles" USING btree ("spaceId");--> statement-breakpoint
CREATE INDEX "smr_user_id_idx" ON "space_member_roles" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "smr_role_id_idx" ON "space_member_roles" USING btree ("roleId");