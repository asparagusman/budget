// Pure calculation core — zero I/O, zero React, zero DB. Every financial rule
// in this application lives here and nowhere else; later phases render this
// module's output, they never recompute it.
//
// JS has no `export type`, so the type surface is re-declared as @typedef
// aliases below. A @typedef in a module is reachable from outside as
// `import("@budget/engine").Cents`, so consumers see one flat public API
// exactly as they did before.

export { toCents, divideCents, pctOfCents, sumCents } from "./money.js";
/** @typedef {import("./money.js").Cents} Cents */

export { OCCURRENCES_PER_YEAR, annualise, equivalent } from "./cadence.js";
/** @typedef {import("./cadence.js").Cadence} Cadence */

export {
  projectPaydays,
  countPaydays,
  resolveCycle,
  resolveVariant,
  windowLengthDays,
  addDaysIso,
  daysBetween,
  periodsBetween,
} from "./calendar.js";
/** @typedef {import("./calendar.js").IsoDate} IsoDate */
/** @typedef {import("./calendar.js").DateWindow} DateWindow */
/** @typedef {import("./calendar.js").PaySchedule} PaySchedule */
/** @typedef {import("./calendar.js").VariantScheduleEntry} VariantScheduleEntry */
/** @typedef {import("./calendar.js").VariantResolution} VariantResolution */

export {
  projectInstances,
  billsContribution,
  billWindowFigures,
  sumWindowFigures,
  simulateBalance,
  requiredOpeningBalanceCents,
} from "./bills.js";
/** @typedef {import("./bills.js").AmountModel} AmountModel */
/** @typedef {import("./bills.js").Bill} Bill */
/** @typedef {import("./bills.js").BillInstance} BillInstance */
/** @typedef {import("./bills.js").BalancePoint} BalancePoint */
/** @typedef {import("./bills.js").WindowFigures} WindowFigures */

export { resolveVariableBudget, trailingAverageCents } from "./variable-costs.js";
/** @typedef {import("./variable-costs.js").VariableBudgetRow} VariableBudgetRow */

export { computeAllocation, diffAllocations, ALLOCATION_SECTIONS, sectionForStage } from "./allocation.js";
/** @typedef {import("./allocation.js").Basis} Basis */
/** @typedef {import("./allocation.js").AllocationLine} AllocationLine */
/** @typedef {import("./allocation.js").AllocationInput} AllocationInput */
/** @typedef {import("./allocation.js").StageGoal} StageGoal */
/** @typedef {import("./allocation.js").ResolvedLine} ResolvedLine */
/** @typedef {import("./allocation.js").StageResult} StageResult */
/** @typedef {import("./allocation.js").Transfer} Transfer */
/** @typedef {import("./allocation.js").AllocationResult} AllocationResult */
/** @typedef {import("./allocation.js").TransferDelta} TransferDelta */

export { resolveTargetCents, goalEta, goalRequired } from "./goals.js";
/** @typedef {import("./goals.js").TargetMode} TargetMode */
/** @typedef {import("./goals.js").Goal} Goal */

export { futureValueCents, periodRate } from "./projections.js";

// Assertion helpers — used across the workspace wherever TypeScript would
// have reached for a `!`. See invariant.js for why they throw.
export { mustGet, mustAt, mustFind } from "./invariant.js";
