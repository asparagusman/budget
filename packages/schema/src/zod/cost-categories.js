import { z } from "zod";
import { costKind } from "../tables/cost-categories.js";

const costCategoryFields = {
  name: z.string().trim().min(1, "Name is required").max(160),
  kind: z.enum(costKind.enumValues),
  isEssential: z.boolean().default(true),
  colour: z.string().trim().max(60).nullable().optional(),
  sortOrder: z.number().int().default(0),
};

export const createCostCategorySchema = z.object(costCategoryFields);

/** @typedef {z.infer<typeof createCostCategorySchema>} CreateCostCategoryInput */

// Zod's `.partial()` keeps a field's `.default()`, so a PATCH that omits a
// defaulted key still writes that default — a single-field update would
// silently reset a non-essential category to essential, which the allocation
// then deducts. The defaulted fields are respelled here without their
// defaults, the same way people.js and pay-schedules.js already do it, so
// "absent" means "leave alone".
// PATCH /cost-categories/:id — all fields optional so a caller can send just
// one. `kind` is included (unlike, say, income-lines' `variantId`) because a
// mis-created category is plausibly fixed by re-kinding it rather than
// recreating it — nothing else references `kind` as an identity.
export const updateCostCategorySchema = z
  .object({ ...costCategoryFields, isEssential: z.boolean(), sortOrder: z.number().int() })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });

/** @typedef {z.infer<typeof updateCostCategorySchema>} UpdateCostCategoryInput */

export const listCostCategoriesQuerySchema = z.object({
  kind: z.enum(costKind.enumValues).optional(),
});

/** @typedef {z.infer<typeof listCostCategoriesQuerySchema>} ListCostCategoriesQuery */
