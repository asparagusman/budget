// Pure TypeScript calculation core — zero I/O, zero React, zero DB. Every
// financial rule in this application lives here and nowhere else; later
// phases render this module's output, they never recompute it.

export type { Cents } from "./money.js";
export { toCents, divideCents, pctOfCents, sumCents } from "./money.js";

export type { Cadence } from "./cadence.js";
export { OCCURRENCES_PER_YEAR, annualise, equivalent } from "./cadence.js";

export type {
  IsoDate,
  DateWindow,
  PaySchedule,
  VariantScheduleEntry,
  VariantResolution,
} from "./calendar.js";
export {
  projectPaydays,
  countPaydays,
  resolveCycle,
  resolveVariant,
  windowLengthDays,
  addDaysIso,
  daysBetween,
} from "./calendar.js";

export type { AmountModel, Bill, BillInstance, BalancePoint } from "./bills.js";
export { projectInstances, billsContribution, simulateBalance, requiredOpeningBalanceCents } from "./bills.js";

export type {
  Basis,
  AllocationLine,
  AllocationInput,
  ResolvedLine,
  StageResult,
  Transfer,
  AllocationResult,
  TransferDelta,
} from "./allocation.js";
export { computeAllocation, diffAllocations } from "./allocation.js";

export type { TargetMode, Goal } from "./goals.js";
export { resolveTargetCents, goalEta, goalRequired } from "./goals.js";

export { futureValueCents } from "./projections.js";
