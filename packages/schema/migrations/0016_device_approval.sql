-- Device approval replaces passkeys. Hand-written: drizzle-kit would drop and
-- recreate the enum, where renaming the value keeps every existing session
-- valid (a passkey session simply becomes an approved device).
ALTER TYPE "public"."session_auth_method" RENAME VALUE 'passkey' TO 'device';--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "auth_method" SET DEFAULT 'device';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_name" text;--> statement-breakpoint
CREATE TABLE "device_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"code" text NOT NULL,
	"device_name" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_user_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	CONSTRAINT "device_requests_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "device_requests" ADD CONSTRAINT "device_requests_approved_user_id_users_id_fk" FOREIGN KEY ("approved_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_requests" ADD CONSTRAINT "device_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP TABLE "credentials" CASCADE;
