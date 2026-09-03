CREATE TYPE "public"."session_auth_method" AS ENUM('passkey', 'recovery_password');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_password_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_method" "session_auth_method" DEFAULT 'passkey' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_recovery_password_unique" ON "users" USING btree ((("recovery_password_hash" IS NOT NULL))) WHERE "users"."recovery_password_hash" is not null;