CREATE TABLE "income_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "income_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"label" text,
	"amount_cents" integer NOT NULL,
	"cadence" "cadence" NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variant_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "income_lines" ADD CONSTRAINT "income_lines_variant_id_income_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."income_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_lines" ADD CONSTRAINT "income_lines_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_schedule" ADD CONSTRAINT "variant_schedule_variant_id_income_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."income_variants"("id") ON DELETE cascade ON UPDATE no action;