CREATE TABLE "variable_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"cadence" "cadence" DEFAULT 'monthly' NOT NULL,
	"effective_from" date NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "variable_actuals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"cycle_start" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "variable_budgets" ADD CONSTRAINT "variable_budgets_category_id_cost_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."cost_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variable_actuals" ADD CONSTRAINT "variable_actuals_category_id_cost_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."cost_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "variable_budgets_category_id_effective_from_unique" ON "variable_budgets" USING btree ("category_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "variable_actuals_category_id_cycle_start_unique" ON "variable_actuals" USING btree ("category_id","cycle_start");