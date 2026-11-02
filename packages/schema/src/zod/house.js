import { z } from "zod";
import { houseScheme } from "../tables/house-scenarios.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const id = z.string().uuid();
// Integer cents, inside an integer column and well past any house price.
const cents = z.number().int().min(-2_000_000_000).max(2_000_000_000);
const positiveCents = cents.min(0);

// The household-wide half of the house page: which budget every scenario is
// read against. Stored whole under the settings key `house` and replaced
// whole by PUT, so a default here only ever fills a key that was never set.
export const houseSettingsSchema = z.object({
  // The income the household expects once it has bought — not necessarily
  // the variant in force today (parental leave ends; pay returns to usual).
  incomeVariantId: id.nullable().default(null),
  // Fixed-cost categories that end on the day of purchase — rent.
  stopCategoryIds: z.array(id).max(200).default([]),
  // Allocation destinations whose lines carry on after buying (giving, an
  // emergency fund). Matched by account, which outlives any one version's
  // line ids.
  keepAccountIds: z.array(id).max(200).default([]),
  // Accounts whose balances become the deposit.
  cashAccountIds: z.array(id).max(200).default([]),
  // Annual gross salary per person id. Used only to tax a pay change and for
  // income caps — income itself comes from the variant's after-tax lines.
  grossByPerson: z.record(id, positiveCents).default({}),
  ownerCostsPerMonthCents: positiveCents.default(0),
  otherPurchaseCostsCents: positiveCents.default(0),
});

/** @typedef {z.infer<typeof houseSettingsSchema>} HouseSettings */

const houseScenarioFields = {
  name: z.string().trim().min(1, "Name is required").max(160),
  scheme: z.enum(houseScheme.enumValues).default("first_home_guarantee"),
  priceCents: positiveCents.min(1, "Enter a price."),
  purchaseDate: isoDate,
  ratePct: z.number().min(0).max(30),
  childcarePerMonthCents: positiveCents.default(0),
  payChanges: z.record(id, cents).default({}),
  cashOverrideCents: positiveCents.nullable().default(null),
  extraCashCents: cents.default(0),
  lenderLimitCents: positiveCents.nullable().default(null),
  note: z.string().trim().max(2000).nullable().optional(),
};

export const createHouseScenarioSchema = z.object(houseScenarioFields);

/** @typedef {z.infer<typeof createHouseScenarioSchema>} CreateHouseScenarioInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key would still write that default — renaming a scenario would
// wipe its pay changes and typed cash. Every defaulted field is respelled
// here without its default, so "absent" means "leave alone".
export const updateHouseScenarioSchema = z
  .object({
    ...houseScenarioFields,
    scheme: z.enum(houseScheme.enumValues),
    childcarePerMonthCents: positiveCents,
    payChanges: z.record(id, cents),
    cashOverrideCents: positiveCents.nullable(),
    extraCashCents: cents,
    lenderLimitCents: positiveCents.nullable(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateHouseScenarioSchema>} UpdateHouseScenarioInput */

// GET /house?on= — the date cash is projected from. Defaulted to today in the
// handler; a schema-level default would freeze it at module load.
export const houseQuerySchema = z.object({
  on: isoDate.optional(),
});
