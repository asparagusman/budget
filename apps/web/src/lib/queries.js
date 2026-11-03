import { queryOptions } from "@tanstack/react-query";
import { addDaysIso } from "@budget/engine";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";

/** @import { DashboardData } from "@/routes/dashboard-page.jsx" */
/** @import { Goal, GoalsSummary } from "@/routes/goals-page.jsx" */
/** @import { Account } from "@/routes/accounts-page.jsx" */
/** @import { Projections, NetWorth } from "@/routes/projections-page.jsx" */
/** @import { IncomeVariant, Person, ScheduleEntry, ResolveResult } from "@/routes/income-page.jsx" */
/** @import { CostCategory, Cycle, VariableBudget, VariableCostsSummary } from "@/routes/variable-costs-page.jsx" */
/** @import { Plan } from "@/routes/allocation-page.jsx" */
/** @import { MergedInstance } from "@/routes/calendar-page.jsx" */
/** @import { Bill } from "@/lib/fixed-costs-draft.js" */
/** @import { HousePayload } from "@/lib/house.js" */

// The queries a page needs for its first paint, defined once so the page and
// its route loader (router.jsx) ask for exactly the same key and shape.
// The loader runs when the pointer lands on a link to the page, so the data
// downloads alongside the page's code instead of after it has mounted —
// which is the difference between opening on the real page and opening on
// its skeleton.
//
// None of these set a `staleTime`, and none may: the derived queries
// (dashboard, goals, projections) aren't invalidated by edits on other
// pages and stay correct only because every mount refetches. A prefetch only
// means the page opens on the hover-time answer while that refetch runs.
//
// Only the queries whose arguments are knowable from the URL and the clock
// live here. Ones that hang off another query's answer (the allocation
// preview, the fixed-costs contribution window) stay in their page.

/** How far back /projections' net-worth history reaches. */
const NET_WORTH_LOOKBACK_DAYS = 730;

/** @param {string} on */
export const dashboardQueryOptions = (on) =>
  queryOptions({
    queryKey: ["dashboard", on],
    queryFn: async () => {
      const res = await api.dashboard.$get({ query: { on } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {DashboardData} */ (await res.json());
    },
  });

/** @param {string} today */
export const goalsQueryOptions = (today) =>
  queryOptions({
    queryKey: ["goals", today],
    queryFn: async () => {
      // The browser's today, sent: the server's own clock can sit in another
      // zone, and every ETA and "months covered" is counted from this date.
      const res = await api.goals.$get({ query: { on: today } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ goals: Goal[], summary: GoalsSummary, warnings: { code: string, message: string }[] }} */ (
        await res.json()
      );
    },
  });

export const accountsQueryOptions = () =>
  queryOptions({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await api.accounts.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Account[]} */ ((await res.json()).accounts);
    },
  });

/**
 * @param {"12" | "24" | "36" | "60"} months
 * @param {string} today
 */
export const projectionsQueryOptions = (months, today) =>
  queryOptions({
    queryKey: ["projections", months, today],
    queryFn: async () => {
      // The browser's today: "now" on every series is counted from it, and
      // the server's own clock can sit in another zone.
      const res = await api.projections.$get({ query: { months, on: today } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Projections} */ (await res.json());
    },
  });

/** @param {string} today */
export const netWorthQueryOptions = (today) =>
  queryOptions({
    queryKey: ["net-worth", today],
    queryFn: async () => {
      const res = await api["net-worth"].$get({
        query: { from: addDaysIso(today, -NET_WORTH_LOOKBACK_DAYS), to: today },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {NetWorth} */ (await res.json());
    },
  });

/** @param {string} today */
export const houseQueryOptions = (today) =>
  queryOptions({
    queryKey: ["house", today],
    queryFn: async () => {
      // The browser's today: cash is projected from this date.
      const res = await api.house.$get({ query: { on: today } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {HousePayload} */ (/** @type {unknown} */ (await res.json()));
    },
  });

export const incomeVariantsQueryOptions = () =>
  queryOptions({
    queryKey: ["income-variants"],
    queryFn: async () => {
      const res = await api["income-variants"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ variants: IncomeVariant[], hasPrimaryPaySchedule: boolean }} */ (await res.json());
    },
  });

export const peopleQueryOptions = () =>
  queryOptions({
    queryKey: ["people"],
    queryFn: async () => {
      const res = await api.people.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Person[]} */ ((await res.json()).people);
    },
  });

export const variantScheduleQueryOptions = () =>
  queryOptions({
    queryKey: ["variant-schedule"],
    queryFn: async () => {
      const res = await api["variant-schedule"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {ScheduleEntry[]} */ ((await res.json()).variantSchedule);
    },
  });

/** @param {string} on */
export const incomeResolveQueryOptions = (on) =>
  queryOptions({
    queryKey: ["income-resolve", on],
    queryFn: async () => {
      const res = await api.income.resolve.$get({ query: { on } });
      if (!res.ok) throw new Error(await readApiError(res));
      // Cast at the RPC boundary (phases/README.md "API"): Hono's `c.json()`
      // widens the engine's `VariantDiagnostic` discriminated union's `kind`
      // to plain `string` when it infers the route's response type.
      return /** @type {ResolveResult} */ (await res.json());
    },
  });

export const paySchedulesQueryOptions = () =>
  queryOptions({
    queryKey: ["pay-schedules"],
    queryFn: async () => {
      const res = await api["pay-schedules"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).paySchedules;
    },
  });

export const billsQueryOptions = () =>
  queryOptions({
    queryKey: ["bills"],
    queryFn: async () => {
      const res = await api.bills.$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {Bill[]} */ ((await res.json()).bills);
    },
  });

/** @param {"fixed" | "variable"} kind */
export const costCategoriesQueryOptions = (kind) =>
  queryOptions({
    queryKey: ["cost-categories", kind],
    queryFn: async () => {
      const res = await api["cost-categories"].$get({ query: { kind } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {CostCategory[]} */ ((await res.json()).costCategories);
    },
  });

/** @param {string} today */
export const billsDueSoonQueryOptions = (today) =>
  queryOptions({
    queryKey: ["bill-instances", "due-soon", today],
    queryFn: async () => {
      const res = await api["bill-instances"].$get({ query: { from: today, to: addDaysIso(today, 14) } });
      if (!res.ok) throw new Error(await readApiError(res));
      return (await res.json()).instances;
    },
  });

/** @param {number} year */
export const calendarInstancesQueryOptions = (year) =>
  queryOptions({
    queryKey: ["bill-instances", "calendar", year],
    queryFn: async () => {
      const res = await api["bill-instances"].$get({ query: { from: `${year}-01-01`, to: `${year + 1}-01-01` } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {MergedInstance[]} */ ((await res.json()).instances);
    },
  });

export const variableBudgetsQueryOptions = () =>
  queryOptions({
    queryKey: ["variable-budgets"],
    queryFn: async () => {
      const res = await api["variable-budgets"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {VariableBudget[]} */ ((await res.json()).variableBudgets);
    },
  });

/** @param {string} today */
export const variableCostsSummaryQueryOptions = (today) =>
  queryOptions({
    queryKey: ["variable-costs-summary", today],
    queryFn: async () => {
      const res = await api["variable-costs"].summary.$get({ query: { on: today } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {VariableCostsSummary} */ (await res.json());
    },
  });

/**
 * Answers 400 until there is a primary pay schedule, so the page only turns
 * it on once there is one; a prefetch before then just caches that refusal.
 *
 * @param {number} periods
 * @param {string} today
 */
export const variableCostsCyclesQueryOptions = (periods, today) =>
  queryOptions({
    queryKey: ["variable-costs-cycles", periods, today],
    queryFn: async () => {
      const res = await api["variable-costs"].cycles.$get({ query: { periods: String(periods), on: today } });
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ cycles: Cycle[] }} */ (await res.json());
    },
  });

export const allocationPlansQueryOptions = () =>
  queryOptions({
    queryKey: ["allocation-plans"],
    queryFn: async () => {
      const res = await api["allocation-plans"].$get();
      if (!res.ok) throw new Error(await readApiError(res));
      return /** @type {{ plans: Plan[] }} */ (await res.json()).plans;
    },
  });
