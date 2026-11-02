CREATE TYPE "public"."house_scheme" AS ENUM('first_home_guarantee', 'help_to_buy', 'standard');--> statement-breakpoint
CREATE TABLE "house_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scheme" "house_scheme" DEFAULT 'first_home_guarantee' NOT NULL,
	"price_cents" integer NOT NULL,
	"purchase_date" date NOT NULL,
	"rate_pct" numeric(6, 3) NOT NULL,
	"childcare_per_month_cents" integer DEFAULT 0 NOT NULL,
	"pay_changes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cash_override_cents" integer,
	"extra_cash_cents" integer DEFAULT 0 NOT NULL,
	"lender_limit_cents" integer,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
