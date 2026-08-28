CREATE TYPE "public"."cost_kind" AS ENUM('fixed', 'variable');--> statement-breakpoint
CREATE TYPE "public"."amount_model" AS ENUM('flat', 'seasonal', 'rolling_average', 'escalating');--> statement-breakpoint
CREATE TABLE "cost_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "cost_kind" NOT NULL,
	"is_essential" boolean DEFAULT true NOT NULL,
	"colour" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner_person_id" uuid,
	"paid_from_account_id" uuid,
	"base_amount_cents" integer NOT NULL,
	"frequency" "cadence" NOT NULL,
	"anchor_date" date NOT NULL,
	"amount_model" "amount_model" DEFAULT 'flat' NOT NULL,
	"escalation_pct" numeric(5, 2),
	"rolling_window" integer,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bill_seasonal_factors" (
	"bill_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"factor" numeric(6, 4) DEFAULT 1 NOT NULL,
	CONSTRAINT "bill_seasonal_factors_bill_id_month_pk" PRIMARY KEY("bill_id","month")
);
--> statement-breakpoint
CREATE TABLE "bill_step_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"new_amount_cents" integer NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "bill_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"expected_cents" integer,
	"actual_cents" integer,
	"paid_on" date,
	"is_override" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_category_id_cost_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."cost_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_seasonal_factors" ADD CONSTRAINT "bill_seasonal_factors_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_step_changes" ADD CONSTRAINT "bill_step_changes_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_instances" ADD CONSTRAINT "bill_instances_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_step_changes_bill_id_effective_from_unique" ON "bill_step_changes" USING btree ("bill_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "bill_instances_bill_id_due_date_unique" ON "bill_instances" USING btree ("bill_id","due_date");