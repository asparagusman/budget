// Fixture B: Fixture A with the unlabelled second Rent bill deleted. No other
// input changes — the Car category's Roadside Assist rows correct
// themselves (this list includes them, unlike
// `FIXED_COST_BILLS_AS_SPREADSHEET_TOTAL`) because subtotals here are
// derived from category membership, not a hand-typed cell range.
import { FIXED_COST_BILLS } from "./as-spreadsheet.js";

export const FIXED_COST_BILLS_CORRECTED = FIXED_COST_BILLS.filter((b) => b.id !== "rent_unlabelled_duplicate");
