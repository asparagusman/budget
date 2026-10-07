-- Archiving a primary pay schedule or the income-landing account used to set
-- only archived_at, leaving the flag on a row every computation ignores. The
-- partial unique indexes still counted it, so no other schedule could become
-- primary and no other account could take the landing flag. The API now
-- clears the flag on archive; this clears it on rows archived before that,
-- ahead of the next migration narrowing both indexes to live rows.
UPDATE "pay_schedules" SET "is_primary" = false WHERE "is_primary" AND "archived_at" IS NOT NULL;--> statement-breakpoint
UPDATE "accounts" SET "is_income_landing" = false WHERE "is_income_landing" AND "archived_at" IS NOT NULL;
