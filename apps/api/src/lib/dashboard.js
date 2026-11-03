import {
  addDaysIso,
  ALLOCATION_SECTIONS,
  daysBetween,
  equivalent,
  resolveCycle,
  resolveVariant,
  sumCents,
} from "@budget/engine";
import {
  findVersionByStatus,
  linesForVersion,
  loadAllocationContext,
  compareWithApplied,
  readAppliedSnapshot,
  resolveActiveAllocation,
  serializeLine,
} from "./allocation.js";
import { getBackupStatus } from "./backup.js";
import { projectActiveBills } from "./bills.js";
import { todayIso } from "./dates.js";
import { loadGoals, loadNetWorth } from "./goals.js";
import { serializeVariant } from "./income.js";

/** @import { Cadence, Cents, IsoDate } from "@budget/engine" */
/** @import { AllocationContext, AppliedComparison } from "./allocation.js" */

// Far enough ahead to always find five bills for the Upcoming card, whatever
// the household's cadences. Nothing is averaged over it — it is a lookup
// window, not a contribution window (that one is `FIXED_COST_WINDOW_DAYS`,
// four years, and lives in lib/allocation.js).
const UPCOMING_WINDOW_DAYS = 90;

// "Total due in 14 days" (phases/10-dashboard.md "Upcoming").
const DUE_SOON_DAYS = 14;

const UPCOMING_COUNT = 5;

// The net-worth card's window: twelve months back from the reported date.
const NET_WORTH_DAYS = 365;

// A balance older than this makes every figure derived from it quietly wrong,
// so the dashboard says so (phases/10-dashboard.md "Net worth").
const STALE_BALANCE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The warnings strip's one line about backups: a failed attempt first, since
 * it is the louder problem and says how old the last good one is anyway, then
 * a weekly backup that is overdue. Measured against the wall clock, not the
 * dashboard's `on` — stepping to next fortnight doesn't make a backup older.
 *
 * @param {import("./backup.js").BackupStatus} status
 * @param {Date} now
 * @returns {{ code: string, message: string } | null}
 */
function backupWarning(status, now) {
  const age = status.newestAutomaticAt
    ? Math.floor((now.getTime() - new Date(status.newestAutomaticAt).getTime()) / DAY_MS)
    : null;
  const ageText = age === null ? null : age === 1 ? "1 day" : `${age} days`;
  if (status.lastAttempt && !status.lastAttempt.ok) {
    const reason = status.lastAttempt.error ?? "no reason was recorded";
    return {
      code: "backup_failed",
      message:
        ageText === null
          ? `The last backup failed (${reason}), and there is no automatic backup yet.`
          : `The last backup failed (${reason}). The newest automatic one is ${ageText} old.`,
    };
  }
  if (status.overdue) {
    return {
      code: "backup_overdue",
      message:
        ageText === null
          ? "There is no automatic backup yet — one should be taken within the hour."
          : `No backup in ${ageText} — the weekly one should have run by now.`,
    };
  }
  return null;
}

// Where each warning is FIXED — a warning the operator cannot act on from the
// dashboard is just noise (phases/10-dashboard.md "Warnings strip"). Codes
// come from the phases that raise them; anything unmapped links to Settings
// rather than nowhere.
/** @type {Record<string, string>} */
const WARNING_HREFS = {
  variant_overlap: "/income",
  variant_gap: "/income",
  over_allocated: "/allocation",
  unallocated: "/allocation",
  unapplied_draft: "/allocation",
  transfers_drifted: "/allocation",
  applied_cadence_changed: "/allocation",
  no_active_allocation: "/allocation",
  ambiguous_active_allocation: "/allocation",
  no_income_landing_account: "/accounts",
  // Pay schedules live on /income now (the old Settings tab redirects there),
  // and the section carries this id.
  no_primary_pay_schedule: "/income#pay-schedules",
  stale_balance: "/accounts",
  no_balance_recorded: "/accounts",
  unconfirmed_due_dates: "/costs/fixed",
  orphaned_instances: "/costs/fixed",
  incomplete_seasonal_curve: "/costs/fixed",
  no_budget_set: "/costs/variable",
  backup_failed: "/admin/backups",
  backup_overdue: "/admin/backups",
};

// How a cadence reads inside a sentence the API composes. The web has its own
// labels for its own controls; a warning is prose, so it needs prose.
/** @type {Record<Cadence, string>} */
const CADENCE_PHRASES = {
  weekly: "weekly",
  fortnightly: "fortnightly",
  monthly: "monthly",
  every_2_months: "every two months",
  quarterly: "quarterly",
  every_6_months: "every six months",
  yearly: "yearly",
};

/** @param {{ code: string, message: string }} warning */
function withHref(warning) {
  return { code: warning.code, message: warning.message, href: WARNING_HREFS[warning.code] ?? "/settings/users" };
}

/**
 * Money and dates inside a warning sentence. The web's `formatMoney` renders
 * every figure the browser draws, but a warning is a sentence this API
 * composes, so it makes the same `Intl` calls here — with the operator's own
 * currency and locale from settings, never a hardcoded "$". Same fallbacks as
 * routes/settings.js for a database `db:seed` hasn't reached yet.
 *
 * @param {import("@budget/schema").Db} db
 */
async function loadFormatters(db) {
  const rows = await db.query.settings.findMany({
    where: (s, { inArray }) => inArray(s.key, ["currency", "locale"]),
  });
  const currency = rows.find((r) => r.key === "currency")?.value;
  const localeValue = rows.find((r) => r.key === "locale")?.value;
  const locale = typeof localeValue === "string" ? localeValue : "en-AU";
  /** @type {Intl.NumberFormatOptions} */
  const moneyOptions = {
    style: "currency",
    currency: typeof currency === "string" ? currency : "AUD",
    maximumFractionDigits: 2,
  };
  const plain = new Intl.NumberFormat(locale, moneyOptions);
  // A change is only legible with its direction attached: "+$12.30" and
  // "−$12.30" are two different instructions to the bank.
  const signed = new Intl.NumberFormat(locale, { ...moneyOptions, signDisplay: "exceptZero" });
  // A calendar date is a date, not an instant — formatted in UTC so the
  // server's own zone can never move it a day (README "Dates").
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return {
    /** @param {Cents} cents */
    money: (cents) => plain.format(cents / 100),
    /** @param {Cents} cents */
    signedMoney: (cents) => signed.format(cents / 100),
    /** @param {IsoDate} iso */
    date: (iso) => day.format(new Date(`${iso}T00:00:00Z`)),
  };
}

/**
 * One sentence for a plan that commits more than it has, naming the amount.
 * The engine says how deep the shortfall went and which lines went below zero
 * to absorb it; this only words it.
 *
 * @param {import("@budget/engine").OverAllocation} over
 * @param {(cents: Cents) => string} money
 */
function overAllocatedMessage(over, money) {
  const n = over.negativeLineIds.length;
  const lines = `${n} line${n === 1 ? "" : "s"}`;
  if (over.shortfallPerMonthCents === 0) {
    return `${lines} in this plan ${n === 1 ? "resolves" : "resolve"} below zero, which no transfer can do. Nothing is rebalanced for you.`;
  }
  const absorbed = n > 0 ? `, and ${lines} ${n === 1 ? "goes" : "go"} below zero to absorb it` : "";
  return `This plan commits ${money(over.shortfallPerMonthCents)} a month more than the income it divides${absorbed}. Nothing is rebalanced for you.`;
}

/**
 * Every non-archived account with the newest balance snapshot recorded against
 * it. Snapshots come back ascending, so the last one written into the map per
 * account is that account's latest — one query instead of one per account.
 *
 * @param {import("@budget/schema").Db} db
 */
async function loadAccountsWithBalances(db) {
  const [accountRows, snapshots] = await Promise.all([
    db.query.accounts.findMany({
      where: (a, { isNull: isNullCol }) => isNullCol(a.archivedAt),
      orderBy: (a, { asc }) => [asc(a.sortOrder), asc(a.name)],
    }),
    db.query.balanceSnapshots.findMany({ orderBy: (b, { asc }) => [asc(b.asAt)] }),
  ]);

  /** @type {Map<string, { amountCents: Cents, asAt: IsoDate }>} */
  const latest = new Map();
  for (const snapshot of snapshots) {
    latest.set(snapshot.accountId, { amountCents: snapshot.amountCents, asAt: snapshot.asAt });
  }

  return accountRows.map((account) => ({
    id: account.id,
    name: account.name,
    type: account.type,
    isIncomeLanding: account.isIncomeLanding,
    latestBalance: latest.get(account.id) ?? null,
  }));
}

/**
 * The next few bills and what falls due inside a fortnight. `actualCents ??
 * expectedCents` is the same precedence `billsContribution` uses, so a bill
 * the operator has already entered an actual for reads the same here as it
 * does in the contribution it feeds.
 *
 * @param {import("@budget/schema").Db} db
 * @param {IsoDate} on
 */
async function loadUpcomingBills(db, on) {
  const window = { from: on, to: addDaysIso(on, UPCOMING_WINDOW_DAYS) };
  const [{ bills, allInstances }, people] = await Promise.all([
    projectActiveBills(db, window),
    db.query.people.findMany({ columns: { id: true, name: true } }),
  ]);
  const nameById = new Map(bills.map((b) => [b.id, b.name]));
  // Whose bill it is, for the card to say "Car rego · Grace". Null is Shared.
  // Archived people stay in the lookup: a bill still belongs to someone who
  // has since left the household.
  const personNameById = new Map(people.map((p) => [p.id, p.name]));
  const ownerById = new Map(
    bills.map((b) => [b.id, b.ownerPersonId ? (personNameById.get(b.ownerPersonId) ?? null) : null]),
  );
  // An imported bill's date is a placeholder until set (tables/bills.js), so
  // every "due on" below inherits that doubt — carried per row so the card
  // can say which dates are real.
  const confirmedById = new Map(bills.map((b) => [b.id, b.dueDateConfirmed]));

  /** @param {{ expectedCents: Cents, actualCents: Cents | null }} instance */
  const amountOf = (instance) => instance.actualCents ?? instance.expectedCents;

  const ascending = allInstances
    .filter((i) => i.dueDate >= window.from && i.dueDate < window.to)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const dueSoonCutoff = addDaysIso(on, DUE_SOON_DAYS);

  return {
    billCount: bills.length,
    unconfirmedDueDateCount: bills.filter((b) => !b.dueDateConfirmed).length,
    upcoming: ascending.slice(0, UPCOMING_COUNT).map((instance) => ({
      billId: instance.billId,
      billName: nameById.get(instance.billId) ?? "Unnamed bill",
      ownerName: ownerById.get(instance.billId) ?? null,
      dueDate: instance.dueDate,
      dueDateConfirmed: confirmedById.get(instance.billId) ?? true,
      amountCents: amountOf(instance),
    })),
    dueNext14DaysCents: sumCents(ascending.filter((i) => i.dueDate < dueSoonCutoff).map(amountOf)),
    dueSoonDays: DUE_SOON_DAYS,
  };
}

/**
 * Phase 07's per-category summary rolled up to one household figure. Only the
 * categories that actually have a trailing average take part — averaging a
 * category with no recorded cycles in as a zero would understate spending and
 * read as a saving that is not there. Null (never zero) when no category has
 * enough history, the same convention `summarizeVariableCategory` uses.
 *
 * @param {AllocationContext} context
 */
function rollUpVariable(context) {
  const hasCadence = context.hasPrimaryPaySchedule;
  /** @param {Cents} cents */
  const perPay = (cents) => (hasCadence ? equivalent(cents, "monthly", context.payCadence) : null);

  /** @type {Cents[]} */
  const trailing = [];
  /** @type {Cents[]} */
  const budgeted = [];
  let cyclesRecorded = 0;
  for (const category of context.variableSummary.byCategory) {
    cyclesRecorded = Math.max(cyclesRecorded, category.cyclesRecorded);
    if (category.trailingAveragePerMonthCents === null) continue;
    trailing.push(category.trailingAveragePerMonthCents);
    budgeted.push(category.budgetPerMonthCents);
  }

  const trailingAveragePerMonthCents = trailing.length > 0 ? sumCents(trailing) : null;

  return {
    essentialPerMonthCents: context.variableEssentialsPerMonthCents,
    essentialPerPayCents: perPay(context.variableEssentialsPerMonthCents),
    nonEssentialPerMonthCents: context.variableNonEssentialPerMonthCents,
    trailingAveragePerMonthCents,
    trailingAveragePerPayCents:
      trailingAveragePerMonthCents === null ? null : perPay(trailingAveragePerMonthCents),
    // Per MONTH, matching the budget it is measured against. Positive means
    // the household is spending more than it budgeted in the categories that
    // have history — never inverted here, only in how the UI colours it.
    varianceCents:
      trailingAveragePerMonthCents === null ? null : trailingAveragePerMonthCents - sumCents(budgeted),
    categoriesWithHistory: trailing.length,
    cyclesRecorded,
  };
}

/**
 * The hero card's figures, grouped by the three SECTIONS — Bills & Essentials,
 * Save Invest & Give, Leftover. They are the headings the spreadsheet has, and
 * they are stages 1/2/3 named, so one tile per section covers every line
 * exactly once and the tiles sum to gross.
 *
 * There is no capping and no "N smaller categories" tile: three sections is
 * three tiles at every width. A per-line `category` grouping lived here, could
 * produce arbitrarily many groups, and had to fall back to grouping by BASIS
 * when no line happened to be named — both paths are gone with the field, and
 * with them the "Allocated out" tile that existed only because the app had no
 * name for the group it was describing (todo.md `[P10-2]`).
 *
 * Every figure comes from the engine's own `StageResult` — nothing here
 * re-derives a percentage or converts a cadence, so a tile cannot disagree
 * with the section it names on /allocation.
 *
 * @param {import("@budget/engine").AllocationResult} result
 * @param {{ stage: number }[]} lines
 * @param {AllocationContext} context
 */
function buildBreakdown(result, lines, context) {
  return ALLOCATION_SECTIONS.map((section) => {
    const stage = result.stages.find((s) => s.stage === section.stage) ?? null;
    return {
      key: section.key,
      label: section.name,
      perMonthCents: stage?.subtotalPerMonthCents ?? 0,
      // The engine already converted this subtotal with the same cadence.
      // Nulling it when there is no primary pay schedule is the repo-wide
      // convention for a per-pay figure with no period to be per.
      perPayCents: context.hasPrimaryPaySchedule ? stage?.subtotalPerPayCents ?? 0 : null,
      pctOfGross: stage?.actualPct ?? null,
      goalPct: stage?.goalPct ?? null,
      // Whether that goal was set on the section or summed from its lines —
      // the same distinction /allocation draws, so the two screens describe
      // one figure the same way.
      goalSource: stage?.goalSource ?? null,
      fidelity: stage?.fidelity ?? null,
      lineCount: lines.filter((line) => line.stage === section.stage).length,
    };
  });
}

/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   done: boolean,
 *   href: string,
 *   hint: string | null,
 *   optional: boolean,
 * }} SetupStep
 *
 * - `hint` — one sentence on what is half-done, when the state says something
 *   more specific than the label (accounts exist but none is marked as where
 *   income lands). Null when the label says it all.
 * - `optional` — shown, but not counted towards `complete`. Only the invite
 *   step: a household of one is a real household, and a setup card that can
 *   never finish would be noise forever after.
 */

/**
 * The household's "still to do" list — the ONE list. The importer's
 * post-commit summary used to keep its own, in React state, so it was gone
 * the moment the operator navigated away; the dashboard's card kept a second
 * that missed steps and ticked "accounts" for any account at all. Both now
 * read this, and every step is derived from what the database holds, so it
 * survives navigation, reloads and the other household member's session, and
 * a step ticks itself the moment the thing exists — nothing is ever marked
 * done by hand (phases/README.md "No todo semantics").
 *
 * Steps that only make sense in some states are present only in those
 * states: the due-date step while an imported placeholder is left, the
 * invite step while the household has exactly one active user.
 *
 * `today` rather than the dashboard's `?on=`: "is a variant scheduled" asks
 * about setup, and browsing a past cycle should not un-tick it.
 *
 * @param {import("@budget/schema").Db} db
 * @param {IsoDate} today
 */
export async function loadSetup(db, today) {
  const [
    peopleRows,
    accountRows,
    scheduleRows,
    variantRows,
    lineRows,
    entryRows,
    billRows,
    categoryRows,
    budgetRows,
    planRows,
    versionRows,
    userRows,
    inviteRows,
  ] = await Promise.all([
    db.query.people.findMany({ where: (p, { isNull }) => isNull(p.archivedAt), columns: { id: true } }),
    db.query.accounts.findMany({
      where: (a, { isNull }) => isNull(a.archivedAt),
      columns: { id: true, isIncomeLanding: true },
    }),
    db.query.paySchedules.findMany({
      where: (p, { isNull }) => isNull(p.archivedAt),
      columns: { id: true, isPrimary: true },
    }),
    db.query.incomeVariants.findMany({ where: (v, { isNull }) => isNull(v.archivedAt), columns: { id: true } }),
    db.query.incomeLines.findMany({ columns: { variantId: true } }),
    // Every entry, archived variant or not — the same rows
    // `loadAllocationContext` resolves the running variant from.
    db.query.variantSchedule.findMany({ columns: { variantId: true, startsOn: true, endsOn: true } }),
    db.query.bills.findMany({
      where: (b, { isNull }) => isNull(b.archivedAt),
      columns: { id: true, dueDateConfirmed: true },
    }),
    db.query.costCategories.findMany({
      where: (c, { and, eq, isNull }) => and(eq(c.kind, "variable"), isNull(c.archivedAt)),
      columns: { id: true },
    }),
    db.query.variableBudgets.findMany({ columns: { categoryId: true } }),
    db.query.allocationPlans.findMany({ where: (p, { isNull }) => isNull(p.archivedAt), columns: { id: true } }),
    db.query.allocationVersions.findMany({
      where: (v, { inArray }) => inArray(v.status, ["active", "draft"]),
      columns: { planId: true, status: true },
    }),
    db.query.users.findMany({ where: (u, { eq }) => eq(u.isActive, true), columns: { id: true } }),
    db.query.invites.findMany({
      where: (i, { and, eq, isNull }) => and(eq(i.purpose, "new_user"), isNull(i.consumedAt)),
      columns: { expiresAt: true },
    }),
  ]);

  const hasLanding = accountRows.some((a) => a.isIncomeLanding);
  const hasPrimary = scheduleRows.some((s) => s.isPrimary);
  const variantIds = new Set(variantRows.map((v) => v.id));
  const variantsWithLines = new Set(lineRows.map((l) => l.variantId).filter((id) => variantIds.has(id)));
  const resolution = resolveVariant(entryRows, today);
  const diagnostic = resolution.diagnostics[0] ?? null;
  const unconfirmed = billRows.filter((b) => !b.dueDateConfirmed).length;
  const budgeted = new Set(budgetRows.map((b) => b.categoryId));
  const categoriesWithBudget = categoryRows.filter((c) => budgeted.has(c.id)).length;
  const livePlanIds = new Set(planRows.map((p) => p.id));
  const liveVersions = versionRows.filter((v) => livePlanIds.has(v.planId));
  const hasActive = liveVersions.some((v) => v.status === "active");
  const hasDraft = liveVersions.some((v) => v.status === "draft");
  const now = Date.now();
  const pendingInvite = inviteRows.some((i) => i.expiresAt.getTime() > now);

  /** @type {SetupStep[]} */
  const steps = [
    {
      key: "people",
      label: "Add the people in your household",
      done: peopleRows.length > 0,
      href: "/admin/people",
      hint: null,
      optional: false,
    },
    {
      key: "income_landing_account",
      label: "Add your accounts, and mark the one your pay lands in",
      done: hasLanding,
      href: "/accounts",
      hint:
        !hasLanding && accountRows.length > 0
          ? "None of your accounts is marked as the one income lands in, so no transfer can be told from money that stays put."
          : null,
      optional: false,
    },
    {
      key: "pay_schedule",
      label: "Set a primary pay schedule",
      done: hasPrimary,
      href: "/income#pay-schedules",
      hint:
        !hasPrimary && scheduleRows.length > 0
          ? "A pay schedule exists, but none is marked primary — transfers are per month until one is."
          : null,
      optional: false,
    },
    {
      key: "income_variant",
      label: "Add your income: a variant with at least one income line",
      done: variantsWithLines.size > 0,
      href: "/income",
      hint:
        variantsWithLines.size === 0 && variantRows.length > 0 ? "Your income variants have no income lines yet." : null,
      optional: false,
    },
    {
      key: "variant_schedule",
      label: "Schedule which income variant is running now",
      done: resolution.variantId !== null,
      href: "/income",
      hint:
        resolution.variantId !== null
          ? null
          : diagnostic?.kind === "overlap"
            ? `${diagnostic.variantIds.length} income variants are all scheduled for today, so none is in effect.`
            : entryRows.length > 0
              ? "No schedule entry covers today."
              : "One open-ended schedule entry is enough, even with a single variant.",
      optional: false,
    },
    {
      key: "bills",
      label: "Record your fixed-cost bills",
      done: billRows.length > 0,
      href: "/costs/fixed",
      hint: null,
      optional: false,
    },
  ];

  if (unconfirmed > 0) {
    steps.push({
      key: "due_dates",
      label: `Set the real due date of ${unconfirmed} imported bill${unconfirmed === 1 ? "" : "s"}`,
      done: false,
      href: "/costs/fixed",
      hint: "The import dates every bill it creates to one placeholder day, and the calendar, the bills buffer and the balance curve are all computed from it.",
      optional: false,
    });
  }

  steps.push(
    {
      key: "variable_budgets",
      label: "Set a budget for your variable-cost categories",
      done: categoriesWithBudget > 0,
      href: "/costs/variable",
      hint:
        categoriesWithBudget === 0 && categoryRows.length > 0
          ? "Your variable-cost categories have no budget yet."
          : null,
      optional: false,
    },
    {
      key: "allocation",
      label: "Build an allocation plan and apply it",
      done: hasActive,
      href: "/allocation",
      hint:
        !hasActive && hasDraft
          ? "A plan is drafted but not applied — imported plans always land as drafts, because only you decide what the standing orders are."
          : null,
      optional: false,
    },
  );

  if (userRows.length === 1) {
    steps.push({
      key: "invite",
      label: "Invite the rest of your household",
      done: pendingInvite,
      href: "/admin/invites",
      hint: pendingInvite ? "An invite is waiting to be used." : null,
      optional: true,
    });
  }

  /** @param {string} key */
  const isDone = (key) => steps.find((s) => s.key === key)?.done ?? false;

  return {
    // The five booleans the card read before `steps` existed, kept so an
    // older client still renders. `accounts` now means what its label always
    // said — an income-landing account exists — rather than "any account".
    people: isDone("people"),
    paySchedule: isDone("pay_schedule"),
    accounts: isDone("income_landing_account"),
    bills: isDone("bills"),
    allocation: isDone("allocation"),
    complete: steps.every((s) => s.done || s.optional),
    steps,
    // Offered while the household is empty: one import fills in people,
    // income, bills, budgets and draft plans in one go.
    importHref: peopleRows.length === 0 && billRows.length === 0 && variantRows.length === 0 ? "/import" : null,
  };
}

/** @typedef {Awaited<ReturnType<typeof loadSetup>>} Setup */

/**
 * The warning for standing transfers whose live figure has moved off what
 * was recorded at apply — or, when the pay cadence itself changed, the one
 * saying the record can no longer be compared at all.
 *
 * Only real standing orders are named. The income-landing account's
 * "transfer" is money that stays where it landed (tables/accounts.js), so a
 * change there is not a bank order anyone has to edit.
 *
 * @param {{
 *   comparison: AppliedComparison,
 *   live: import("@budget/engine").Transfer[],
 *   planName: string,
 *   versionNumber: number,
 *   payCadence: Cadence,
 *   nameOf: (accountId: string) => string,
 *   format: Awaited<ReturnType<typeof loadFormatters>>,
 * }} args
 * @returns {{ code: string, message: string } | null}
 */
function appliedDriftWarning({ comparison, live, planName, versionNumber, payCadence, nameOf, format }) {
  const { snapshot } = comparison;
  if (!snapshot) return null;
  const which = `The ${planName} plan (v${versionNumber}) was applied on ${format.date(snapshot.appliedOn)}`;

  if (comparison.status === "cadence_changed") {
    return {
      code: "applied_cadence_changed",
      message: `${which} with ${CADENCE_PHRASES[snapshot.payCadence]} transfers, but the primary pay schedule is now ${CADENCE_PHRASES[payCadence]}. The amounts recorded then can't be compared to today's — re-apply the plan to record them.`,
    };
  }

  const liveById = new Map(live.map((t) => [t.accountId, t]));
  const appliedById = new Map(snapshot.transfers.map((t) => [t.accountId, t]));
  const moved = (comparison.drift ?? []).filter((d) => {
    if (d.deltaPerPayCents === 0) return false;
    const stayedPut = (liveById.get(d.accountId)?.isNoOp ?? true) && (appliedById.get(d.accountId)?.isNoOp ?? true);
    return !stayedPut;
  });
  if (moved.length === 0) return null;

  const list = moved.map((d) => `${nameOf(d.accountId)} ${format.signedMoney(d.deltaPerPayCents)}`).join(", ");
  return {
    code: "transfers_drifted",
    message: `${which}, and ${moved.length === 1 ? "one standing transfer has" : `${moved.length} standing transfers have`} moved since: ${list} per pay. Update ${moved.length === 1 ? "that bank order" : "those bank orders"}, or re-apply the plan to record the new amounts.`,
  };
}

/**
 * The whole `/dashboard` payload. Every figure is read from the endpoint or
 * engine function that owns it — this file sums, filters and picks, and does
 * no financial arithmetic of its own. A second implementation of a rule here
 * is how the dashboard and the screen it links to drift apart
 * (phases/10-dashboard.md "Data").
 *
 * @param {import("@budget/schema").Db} db
 * @param {IsoDate} on
 * @param {{ backupDir?: string }} [options] where backups are kept; without
 *   one the strip says nothing about them (the read-only test app has none).
 */
export async function loadDashboard(db, on, { backupDir } = {}) {
  const context = await loadAllocationContext(db, on);
  const allocation = await resolveActiveAllocation(db, context);
  const now = new Date();

  const [accounts, billsPayload, netWorthPayload, goalsPayload, setup, draftVersion, activeLines, format, backups] =
    await Promise.all([
      loadAccountsWithBalances(db),
      loadUpcomingBills(db, on),
      loadNetWorth(db, { from: addDaysIso(on, -NET_WORTH_DAYS), to: on }),
      loadGoals(db, { on, context, allocation }),
      loadSetup(db, todayIso()),
      allocation.plan ? findVersionByStatus(db, allocation.plan.id, "draft") : Promise.resolve(null),
      allocation.version ? linesForVersion(db, allocation.version.id) : Promise.resolve([]),
      loadFormatters(db),
      backupDir ? getBackupStatus(db, now, backupDir) : Promise.resolve(null),
    ]);

  // ---- cycle -------------------------------------------------------------
  // Every date on the screen hangs off the primary pay schedule. Without one
  // there is no cycle to report, so the banner says so rather than inventing
  // a fortnight (phases/README.md "The one rule").
  const resolvedCycle = context.paySchedule ? resolveCycle(context.paySchedule, on) : null;
  const cycle = resolvedCycle
    ? {
        cycleStart: resolvedCycle.cycleStart,
        cycleEnd: resolvedCycle.cycleEnd,
        payCadence: context.payCadence,
        daysRemaining: daysBetween(on, resolvedCycle.cycleEnd),
        // The cycle selector moves by setting `?on=`; handing it the two
        // neighbouring dates keeps cadence arithmetic out of the browser
        // (phases/10-dashboard.md "No financial arithmetic in dashboard
        // components").
        previousOn: addDaysIso(resolvedCycle.cycleStart, -1),
        nextOn: resolvedCycle.cycleEnd,
      }
    : null;

  // ---- variant -----------------------------------------------------------
  const variantRow = context.resolvedVariantId
    ? (await db.query.incomeVariants.findFirst({
        where: (v, { eq: eqCol }) => eqCol(v.id, /** @type {string} */ (context.resolvedVariantId)),
      })) ?? null
    : null;
  const variantLines = variantRow
    ? await db.query.incomeLines.findMany({
        where: (l, { eq: eqCol }) => eqCol(l.variantId, variantRow.id),
        orderBy: (l, { asc }) => [asc(l.sortOrder)],
      })
    : [];
  // Phase 05's own serializer, so the income the banner names is the income
  // /income reports for the same variant to the cent.
  const serialized = variantRow
    ? serializeVariant(variantRow, variantLines, context.hasPrimaryPaySchedule ? context.payCadence : null)
    : null;
  const variant = {
    id: serialized?.id ?? null,
    name: serialized?.name ?? null,
    totalPerPayCents: serialized?.totals.totalCents.perPay ?? null,
    totalPerMonthCents: serialized?.totals.totalCents.perMonth ?? null,
    diagnostics: context.resolutionDiagnostics,
  };

  // ---- allocation --------------------------------------------------------
  const result = allocation.result;
  const grossPerPayCents = context.hasPrimaryPaySchedule
    ? equivalent(allocation.grossPerMonthCents, "monthly", context.payCadence)
    : null;

  // What the bank was told when this version was applied, beside what the
  // plan resolves to today. The live figure is still the one shown — it is
  // what the plan says the order should be — and the recorded one rides along
  // so the card can say quietly when the two have parted. Nothing here, or
  // anywhere, writes a live figure into the record: re-applying is the only
  // way to record new amounts (phases/08-allocation.md "What transfers are,
  // and are not").
  /** @type {AppliedComparison | null} */
  const applied =
    allocation.version && result
      ? compareWithApplied(readAppliedSnapshot(allocation.version), result, context.payCadence)
      : null;
  const driftById = new Map((applied?.drift ?? []).map((d) => [d.accountId, d]));
  const recorded = applied?.status === "recorded";
  const transfers = (result?.transfers ?? []).map((t) => {
    const delta = driftById.get(t.accountId) ?? null;
    return {
      ...t,
      // Null when nothing comparable was recorded (a version applied before
      // amounts were, or one recorded at a different pay cadence). Zero, not
      // null, for a destination the record simply did not have: the record is
      // complete, so absent means no order existed.
      appliedPerPayCents: recorded ? (delta?.fromPerPayCents ?? 0) : null,
      // live − applied, from the engine's own `diffAllocations`.
      driftPerPayCents: recorded ? (delta?.deltaPerPayCents ?? 0) : null,
    };
  });

  const allocationPayload =
    allocation.plan && allocation.version && result
      ? {
          versionId: allocation.version.id,
          version: allocation.version.version,
          planId: allocation.plan.id,
          planName: allocation.plan.name,
          incomeVariantId: allocation.plan.incomeVariantId,
          grossPerMonthCents: allocation.grossPerMonthCents,
          grossPerPayCents,
          transfers,
          // The recorded amounts' provenance. `status` is "not_recorded" for a
          // version applied before amounts were stored, which shows no drift
          // until the next apply records them.
          applied: {
            status: applied?.status ?? "not_recorded",
            appliedOn: applied?.snapshot?.appliedOn ?? null,
            computedOn: applied?.snapshot?.computedOn ?? null,
            payCadence: applied?.snapshot?.payCadence ?? null,
            transfers: applied?.snapshot?.transfers ?? null,
          },
          // The engine's own `StageResult`s, passed through untouched — they
          // already carry per-month, per-pay and per-week. Whether the pay
          // figures mean anything is `grossPerPayCents`/`setup.paySchedule`'s
          // job to say; blanking them here only broke the engine's own type
          // for every component that takes an `AllocationResult`.
          stages: result.stages,
          // Stage, label and destination per line — what the flow diagram
          // needs to draw income -> stage -> account, the same shape
          // /allocation draws it from.
          lines: activeLines.map(serializeLine),
          resolvedLines: result.lines,
          // What the hero card puts under the income figure — grouped here,
          // not in a component (phases/10-dashboard.md "No financial
          // arithmetic in dashboard components").
          breakdown: buildBreakdown(result, activeLines, context),
          unallocatedPerMonthCents: result.unallocatedPerMonthCents,
          goodLifeFidelityCents: result.goodLifeFidelityCents,
          // What the plan leaves a month for non-essentials: the target less
          // the engine's own shortfall against it, which is how the engine
          // measures the Leftover pool (`goodLifeFidelityCents` is
          // `nonEssential − pool`). Said here so the card shows a figure
          // instead of dividing one.
          nonEssentialPoolPerMonthCents: context.variableNonEssentialPerMonthCents - result.goodLifeFidelityCents,
          // Null when the plan fits inside gross. The engine's own flag, passed
          // through so the hero can say what the warnings strip says.
          overAllocation: result.overAllocation ?? null,
          hasDraft: draftVersion !== null,
        }
      : null;

  // ---- net worth ---------------------------------------------------------
  // Before `knownFrom` every total is a zero meaning "unknown", not "empty" —
  // drawing those would put a cliff at the left edge of the chart, and with no
  // snapshot at all (`knownFrom === null`) it would draw a flat zero line for a
  // year, which reads as "we have nothing" rather than "we have never said".
  const series =
    netWorthPayload.knownFrom === null
      ? []
      : netWorthPayload.totalPoints.filter(
          (point) => point.date >= /** @type {IsoDate} */ (netWorthPayload.knownFrom),
        );
  const lastPoint = series[series.length - 1] ?? null;
  const heldAccounts = accounts.filter((a) => a.type !== "external");
  /** @type {IsoDate[]} */
  const recordedDates = [];
  /** @type {typeof heldAccounts} */
  const unrecordedAccounts = [];
  for (const account of heldAccounts) {
    if (account.latestBalance) recordedDates.push(account.latestBalance.asAt);
    else unrecordedAccounts.push(account);
  }
  // ISO dates compare correctly as plain strings, so the oldest is just the
  // smallest.
  const stalestAsAt = recordedDates.length > 0 ? recordedDates.reduce((a, b) => (a < b ? a : b)) : null;
  const netWorth = {
    totalCents: lastPoint ? lastPoint.totalCents : 0,
    series,
    stalestAsAt,
    staleDays: stalestAsAt === null ? null : daysBetween(stalestAsAt, on),
    staleAfterDays: STALE_BALANCE_DAYS,
    accountsWithoutBalance: unrecordedAccounts.length,
  };

  // ---- goals -------------------------------------------------------------
  const activeGoals = goalsPayload.goals.filter((g) => g.goal.status === "active");
  const goals = activeGoals.map((g) => ({
    id: g.goal.id,
    name: g.goal.name,
    accountName: g.account.name,
    progressPct: g.progressPct,
    etaDate: g.eta.date,
    aheadBehindDays: g.eta.aheadBehindDays,
    isFunded: g.isFunded,
    reached: g.reached,
    currentBalanceCents: g.currentBalanceCents,
    targetCents: g.targetCents,
    // False for a months-of-expenses goal before any costs are recorded, when
    // `targetCents` is only a placeholder 0 (see `serializeGoal`).
    targetComputable: g.targetComputable,
  }));

  // ---- setup path --------------------------------------------------------
  // What the operator still has to do before any of the above means anything
  // — `loadSetup`, the one "still to do" list the importer's summary also
  // reads. The dashboard is the first screen they ever see, so it has to be
  // the one that says where to start (phases/10-dashboard.md "Empty state on
  // day one"). Its allocation step asks "have you applied one?", not "does
  // one apply on this date?": an ambiguous income schedule leaves
  // `allocationPayload` null even though the plan exists, and the warnings
  // strip is where that gets said.

  // ---- warnings ----------------------------------------------------------
  // Ordered most-actionable first: the UI shows three and collapses the rest,
  // so the order here decides which three those are.
  /** @type {{ code: string, message: string }[]} */
  const warnings = [];

  for (const diagnostic of context.resolutionDiagnostics) {
    warnings.push(
      diagnostic.kind === "overlap"
        ? {
            code: "variant_overlap",
            message: `${diagnostic.variantIds.length} income variants both cover ${on}, so none is in effect. Fix the schedule and every figure below resolves.`,
          }
        : {
            code: "variant_gap",
            message: `No income variant covers ${on}, so there is nothing to divide. Add a schedule entry covering this date.`,
          },
    );
  }
  // Over-allocation first, and from the engine's flag rather than from
  // unallocated: a sweep stage absorbs a shortfall into negative lines and
  // leaves unallocated at exactly zero, so checking that alone never fired for
  // the plan most households have. A negative unallocated always ends a stage
  // below zero, so the flag covers that case too — one warning per problem.
  const overAllocation = result?.overAllocation ?? null;
  if (overAllocation) {
    warnings.push({
      code: "over_allocated",
      message: overAllocatedMessage(overAllocation, format.money),
    });
  } else if (result && result.unallocatedPerMonthCents > 0) {
    warnings.push({
      code: "unallocated",
      message: "Some income is not allocated anywhere — it stays in the income account.",
    });
  }
  // A standing order that no longer says what the plan says is the next most
  // actionable thing on the screen: it is money going to the wrong place
  // every payday until someone edits it at the bank.
  if (applied && allocation.plan && allocation.version && result) {
    const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));
    const recordedNameById = new Map((applied.snapshot?.transfers ?? []).map((t) => [t.accountId, t.accountName]));
    const drift = appliedDriftWarning({
      comparison: applied,
      live: result.transfers,
      planName: allocation.plan.name,
      versionNumber: allocation.version.version,
      payCadence: context.payCadence,
      // Today's name where the account is still live, the recorded one where
      // it has been archived since.
      nameOf: (id) => accountNameById.get(id) ?? recordedNameById.get(id) ?? "An archived account",
      format,
    });
    if (drift) warnings.push(drift);
  }
  // Next, because it is the one problem here that loses data rather than
  // misstating it.
  const backup = backups ? backupWarning(backups, now) : null;
  if (backup) warnings.push(backup);
  if (allocationPayload?.hasDraft) {
    warnings.push({
      code: "unapplied_draft",
      message: `The ${allocationPayload.planName} plan has an unapplied draft — the transfers below are still the active version's.`,
    });
  }
  if (allocation.warning) warnings.push(allocation.warning);
  if (billsPayload.unconfirmedDueDateCount > 0) {
    const n = billsPayload.unconfirmedDueDateCount;
    warnings.push({
      code: "unconfirmed_due_dates",
      message:
        n === 1
          ? "1 bill still has a placeholder due date from the import — set its real date on Fixed Costs."
          : `${n} bills still have a placeholder due date from the import — set their real dates on Fixed Costs.`,
    });
  }
  if (netWorth.staleDays !== null && netWorth.staleDays > STALE_BALANCE_DAYS) {
    warnings.push({
      code: "stale_balance",
      message: `The oldest account balance is ${netWorth.staleDays} days old — net worth and every goal below are only as accurate as that.`,
    });
  }
  if (unrecordedAccounts.length > 0) {
    warnings.push({
      code: "no_balance_recorded",
      message: `${unrecordedAccounts.length} account${unrecordedAccounts.length === 1 ? " has" : "s have"} no balance recorded yet, so ${unrecordedAccounts.length === 1 ? "it counts" : "they count"} as zero towards net worth.`,
    });
  }
  warnings.push(...context.warnings);
  warnings.push(...context.variableSummary.warnings.map((w) => ({ code: w.code, message: w.message })));

  // One warning per problem. Several phases legitimately raise the same code
  // for the same underlying gap — a missing pay schedule stops both the
  // allocation and the trailing averages — and saying it twice inside a strip
  // that only shows three would push a different problem out of view.
  /** @type {Set<string>} */
  const seenCodes = new Set();
  const deduped = warnings.filter((w) => (seenCodes.has(w.code) ? false : seenCodes.add(w.code)));

  return {
    on,
    cycle,
    variant,
    bills: {
      contributionPerPayCents: context.fixedTotalPerPayCents,
      contributionPerMonthCents: context.fixedTotalPerMonthCents,
      dueNext14DaysCents: billsPayload.dueNext14DaysCents,
      dueSoonDays: billsPayload.dueSoonDays,
      nextDue: billsPayload.upcoming[0] ?? null,
      upcoming: billsPayload.upcoming,
      billCount: billsPayload.billCount,
      unconfirmedDueDateCount: billsPayload.unconfirmedDueDateCount,
    },
    variable: rollUpVariable(context),
    allocation: allocationPayload,
    accounts,
    netWorth,
    goals,
    setup,
    warnings: deduped.map(withHref),
  };
}
