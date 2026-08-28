CREATE TYPE "public"."goal_status" AS ENUM('active', 'achieved', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."target_mode" AS ENUM('amount', 'months_of_expenses');--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_mode" "target_mode" DEFAULT 'amount' NOT NULL,
	"target_amount_cents" integer,
	"target_months" numeric(5, 2),
	"target_date" date,
	"note" text,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;