CREATE TYPE "public"."account_type" AS ENUM('transaction', 'savings', 'investment', 'external');--> statement-breakpoint
CREATE TYPE "public"."cadence" AS ENUM('weekly', 'fortnightly', 'monthly', 'every_2_months', 'quarterly', 'every_6_months', 'yearly');--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"institution" text,
	"is_income_landing" boolean DEFAULT false NOT NULL,
	"annual_growth_rate" numeric(6, 4),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"as_at" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "pay_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"anchor_date" date NOT NULL,
	"cadence" "cadence" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_schedules" ADD CONSTRAINT "pay_schedules_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_income_landing_unique" ON "accounts" USING btree ("is_income_landing") WHERE "accounts"."is_income_landing";--> statement-breakpoint
CREATE UNIQUE INDEX "balance_snapshots_account_id_as_at_unique" ON "balance_snapshots" USING btree ("account_id","as_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_schedules_primary_unique" ON "pay_schedules" USING btree ("is_primary") WHERE "pay_schedules"."is_primary";