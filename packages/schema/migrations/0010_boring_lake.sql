CREATE TABLE "allocation_stage_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"stage" integer NOT NULL,
	"goal_pct" numeric(6, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocation_stage_goals" ADD CONSTRAINT "allocation_stage_goals_version_id_allocation_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."allocation_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocation_stage_goals_version_stage_unique" ON "allocation_stage_goals" USING btree ("version_id","stage");--> statement-breakpoint
-- Stages are now a closed set of three named sections, and the API rejects a
-- stage above 3 on write. Every plan this app has ever created uses 1/2/3 (the
-- seed and the workbook importer both map to them), so this is expected to
-- touch nothing — but an imported plan that somehow holds a stage 4 would
-- otherwise be unsaveable, and folding it into the last section leaves the
-- lines visible and editable rather than stranding them.
UPDATE "allocation_lines" SET "stage" = 3 WHERE "stage" > 3;
