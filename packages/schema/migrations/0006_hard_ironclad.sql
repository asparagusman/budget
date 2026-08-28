CREATE TYPE "public"."allocation_basis" AS ENUM('from_fixed_costs', 'from_variable_essentials', 'pct_of_gross', 'pct_of_remaining', 'fixed_amount', 'sweep');--> statement-breakpoint
CREATE TYPE "public"."allocation_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "allocation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"stage" integer NOT NULL,
	"label" text NOT NULL,
	"basis" "allocation_basis" NOT NULL,
	"value" numeric(12, 4),
	"goal_pct" numeric(6, 2),
	"account_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocation_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"income_variant_id" uuid NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "allocation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "allocation_status" DEFAULT 'draft' NOT NULL,
	"based_on_version_id" uuid,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_version_id_allocation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."allocation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_lines" ADD CONSTRAINT "allocation_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_plans" ADD CONSTRAINT "allocation_plans_income_variant_id_income_variants_id_fk" FOREIGN KEY ("income_variant_id") REFERENCES "public"."income_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_versions" ADD CONSTRAINT "allocation_versions_plan_id_allocation_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."allocation_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_versions" ADD CONSTRAINT "allocation_versions_based_on_version_id_allocation_versions_id_fk" FOREIGN KEY ("based_on_version_id") REFERENCES "public"."allocation_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_versions" ADD CONSTRAINT "allocation_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_versions_plan_id_version_unique" ON "allocation_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_versions_active_unique" ON "allocation_versions" USING btree ("plan_id") WHERE "allocation_versions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_versions_draft_unique" ON "allocation_versions" USING btree ("plan_id") WHERE "allocation_versions"."status" = 'draft';