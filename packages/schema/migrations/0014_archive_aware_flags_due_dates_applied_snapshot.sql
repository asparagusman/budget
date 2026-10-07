DROP INDEX "accounts_income_landing_unique";--> statement-breakpoint
DROP INDEX "pay_schedules_primary_unique";--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "due_date_confirmed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "allocation_versions" ADD COLUMN "applied_snapshot" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_income_landing_unique" ON "accounts" USING btree ("is_income_landing") WHERE "accounts"."is_income_landing" AND "accounts"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_schedules_primary_unique" ON "pay_schedules" USING btree ("is_primary") WHERE "pay_schedules"."is_primary" AND "pay_schedules"."archived_at" IS NULL;