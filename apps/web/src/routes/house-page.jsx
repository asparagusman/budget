import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toCents } from "@budget/engine";
import { CopyIcon, HouseIcon, PencilIcon, PlusIcon, SlidersHorizontalIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Textarea } from "@/components/ui/textarea.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { DatePicker } from "@/components/date-picker.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { GoalsTabs } from "@/components/goals-tabs.jsx";
import { CardsSkeleton } from "@/components/loading.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError, Notice, NoticeList } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { PageGroup, PageSection } from "@/components/page-section.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { Stat, StatGroup } from "@/components/stat-tile.jsx";
import { api } from "@/lib/api.js";
import { houseQueryOptions } from "@/lib/queries.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { formatIsoDate } from "@/lib/dates.js";
import { SCHEMES, SCHEME_LABELS, evaluateScenario, houseSummary, scenarioCash } from "@/lib/house.js";
import { useSettings } from "@/lib/settings.jsx";
import { useNumericText } from "@/lib/use-numeric-text.js";
import { useTodayIso } from "@/lib/use-today.js";
import { cn } from "@/lib/utils.js";

/** @import { Cents, HouseScheme } from "@budget/engine" */
/** @import { EvaluatedScenario, HousePayload, HouseScenario } from "@/lib/house.js" */

/** @typedef {HousePayload["settings"]} HouseSettings */
/** @typedef {Omit<HouseScenario, "id">} ScenarioFields */

// "Most this budget carries" is always under the card's own scheme.
const SCHEME_PHRASES = /** @type {const} */ ({
  first_home_guarantee: "Under the 5% deposit scheme",
  help_to_buy: "Under Help to Buy",
  standard: "With a standard loan",
});

/** @param {number} n @param {number} [digits] */
function pct(n, digits = 0) {
  return `${n.toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// Small inputs
// ---------------------------------------------------------------------------

/**
 * A dollar field that holds its text as typed and steps on the arrow keys.
 *
 * @param {{
 *   id: string, value: string, onChange: (next: string) => void,
 *   step?: number, signed?: boolean, invalid?: boolean, ariaLabel?: string,
 * }} props
 */
function DollarField({ id, value, onChange, step = 100, signed = false, invalid, ariaLabel }) {
  const numeric = useNumericText({ value, onChange, step, min: signed ? undefined : 0 });
  return (
    <InputGroup>
      <InputGroupAddon>
        <InputGroupText>$</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput id={id} aria-label={ariaLabel} aria-invalid={invalid || undefined} className="tabular-nums" {...numeric} />
    </InputGroup>
  );
}

/**
 * @param {{ id: string, value: string, onChange: (next: string) => void, invalid?: boolean }} props
 */
function PercentField({ id, value, onChange, invalid }) {
  const numeric = useNumericText({ value, onChange, step: 0.05, min: 0, max: 30 });
  return (
    <InputGroup>
      <InputGroupInput id={id} aria-invalid={invalid || undefined} className="tabular-nums" {...numeric} />
      <InputGroupAddon align="inline-end">
        <InputGroupText>%</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  );
}

/**
 * The app's segmented control (the same shape as Allocation's cadence
 * switch): one choice from a few, all visible at once.
 *
 * @template {string} T
 * @param {{ id?: string, ariaLabel: string, value: T, options: { value: T, label: string }[], onChange: (next: T) => void }} props
 */
function Segmented({ id, ariaLabel, value, options, onChange }) {
  return (
    <div id={id} role="group" aria-label={ariaLabel} className="flex w-full rounded-(--radius-control) bg-surface-muted p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex-1 rounded-[calc(var(--radius-control)-2px)] px-2.5 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent)",
            value === option.value ? "bg-accent-brand-soft text-accent-brand" : "text-text-muted hover:text-text",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** @param {string} text */
function centsOrNull(text) {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? toCents(n) : null;
}

/** @param {Cents | null | undefined} cents */
function dollarsText(cents) {
  return cents == null ? "" : String(cents / 100);
}

// ---------------------------------------------------------------------------
// A scenario's figures — shared by the card and the edit sheet's preview
// ---------------------------------------------------------------------------

/**
 * @param {{ label: import("react").ReactNode, sub?: import("react").ReactNode, children: import("react").ReactNode }} props
 */
function FigureRow({ label, sub, children }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="min-w-0">
        <span className="text-sm text-text">{label}</span>
        {sub ? <span className="block text-xs text-text-muted">{sub}</span> : null}
      </dt>
      <dd className="shrink-0 text-right text-sm font-medium text-text tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * The repayment and whether the budget carries it, then the purchase, then
 * what would change the answer.
 *
 * @param {{ scenario: ScenarioFields, evaluated: EvaluatedScenario, payload: HousePayload }} props
 */
function ScenarioFigures({ scenario, evaluated, payload }) {
  const { locale } = useSettings();
  const { result: r, cash } = evaluated;
  const spare = r.sparePerMonthCents;
  const isHtb = scenario.scheme === "help_to_buy";
  const countedNames = payload.options.cashAccounts.filter((a) => a.counted).map((a) => a.name);
  const noSalaries = Object.keys(payload.settings.grossByPerson).length === 0;
  const payChanged = Object.values(scenario.payChanges).some((c) => c !== 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium tracking-wide text-text-subtle uppercase">Repayment</p>
        <p className="text-2xl font-bold tracking-tight text-text tabular-nums">
          <Money whole value={r.repaymentPerMonthCents} />
          <span className="text-sm font-normal text-text-subtle"> a month</span>
        </p>
        <p className={cn("text-sm font-semibold", spare >= 0 ? "text-positive" : "text-negative")}>
          <Money whole value={Math.abs(spare)} /> a month {spare >= 0 ? "spare" : "short"}
        </p>
        <p className="text-xs text-text-muted">
          Once everything else and childcare are paid, with Good Life kept at{" "}
          <Money whole value={payload.live.goodLifePerMonthCents} />.
        </p>
      </div>

      <dl className="divide-y divide-border">
        <FigureRow
          label="Cash on the day"
          sub={
            <>
              {cash.typed
                ? "Typed in"
                : `Projected from ${countedNames.length > 0 ? countedNames.join(", ") : "no accounts yet"} to ${formatIsoDate(scenario.purchaseDate, locale)}`}
              {scenario.extraCashCents !== 0 ? (
                <>
                  {", "}
                  <Money whole signed value={scenario.extraCashCents} /> extra
                </>
              ) : null}
            </>
          }
        >
          <Money whole value={cash.cashCents} />
        </FigureRow>
        <FigureRow
          label="Stamp duty and costs"
          sub={r.costs.dutyCents > 0 ? <>Duty <Money whole value={r.costs.dutyCents} /></> : "No stamp duty"}
        >
          <Money whole value={r.costs.totalCents} />
        </FigureRow>
        <FigureRow label="Deposit" sub={`${pct(r.depositPct, 1)} of the price`}>
          <Money whole value={r.depositCents} />
        </FigureRow>
        {r.bufferCents > 0 ? (
          <FigureRow label="Left in the bank" sub="The scheme takes a deposit up to 20%; the rest stays yours">
            <Money whole value={r.bufferCents} />
          </FigureRow>
        ) : null}
        {isHtb ? (
          <FigureRow label="Government share" sub={`${pct(r.governmentSharePct, 1)} of the home, paid back when you sell or buy it out`}>
            <Money whole value={r.governmentShareCents} />
          </FigureRow>
        ) : null}
        <FigureRow label="Loan" sub={`${pct(r.lvrPct)} of the price`}>
          <Money whole value={r.loanCents} />
        </FigureRow>
        <FigureRow label="If rates rise 1%" sub="The same loan, a month">
          <Money whole value={r.repaymentIfRatesRisePerMonthCents} />
        </FigureRow>
        {r.budget.childcarePerMonthCents > 0 ? (
          <FigureRow
            label="Childcare"
            sub={payChanged && r.budget.childcarePerMonthCents !== scenario.childcarePerMonthCents ? "Less subsidy at the higher pay" : "A month, out of pocket"}
          >
            <Money whole value={r.budget.childcarePerMonthCents} />
          </FigureRow>
        ) : null}
        {payChanged ? (
          <FigureRow label="Pay changes" sub="After tax, a month">
            <Money whole signed value={r.netChangePerMonthCents} />
          </FigureRow>
        ) : null}
      </dl>

      <div className="flex flex-col rounded-(--radius-control) bg-surface-muted px-3 py-2">
        <p className="pt-1 text-xs font-semibold text-text-muted">What would it take</p>
        <dl className="divide-y divide-border">
          <FigureRow label="Most this budget carries" sub={`${SCHEME_PHRASES[scenario.scheme]}, the same cash and rate`}>
            {evaluated.maxPriceCents === null ? "Nothing yet" : <Money whole value={evaluated.maxPriceCents} />}
          </FigureRow>
          {isHtb ? (
            <FigureRow label="Cash needed on the day" sub="Under Help to Buy, more cash shrinks the government's share, not the repayment">
              —
            </FigureRow>
          ) : (
            <FigureRow
              label="Cash needed on the day"
              sub={
                evaluated.cashNeededCents === null ? (
                  "No amount of cash makes this price work"
                ) : evaluated.cashNeededCents <= cash.cashCents ? (
                  "You'll have enough"
                ) : (
                  <>
                    You'll have <Money whole value={cash.cashCents} />
                  </>
                )
              }
            >
              {evaluated.cashNeededCents === null ? "—" : <Money whole value={evaluated.cashNeededCents} />}
            </FigureRow>
          )}
          <FigureRow
            label="Or a pay rise of"
            sub={
              noSalaries
                ? "Add your salaries in the budget settings"
                : evaluated.payRiseNeededCents === null
                  ? "The deposit or a price cap is the limit, not pay"
                  : "A year before tax, split evenly between you"
            }
          >
            {evaluated.payRiseNeededCents === null ? (
              "—"
            ) : evaluated.payRiseNeededCents === 0 ? (
              "None needed"
            ) : (
              <Money whole signed value={evaluated.payRiseNeededCents} />
            )}
          </FigureRow>
        </dl>
      </div>

      {r.warnings.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {r.warnings.map((w) => (
            <Notice key={w.code} compact>
              {w.message}
            </Notice>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * @param {{
 *   scenario: HouseScenario, evaluated: EvaluatedScenario, payload: HousePayload,
 *   onEdit: () => void, onDuplicate: () => void, onDelete: () => void,
 * }} props
 */
function ScenarioCard({ scenario, evaluated, payload, onEdit, onDuplicate, onDelete }) {
  const { locale } = useSettings();
  return (
    <section className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-text">
            <span className="min-w-0 truncate">{scenario.name}</span>
            <Badge variant="secondary">{SCHEME_LABELS[scenario.scheme]}</Badge>
          </h3>
          <p className="text-xs text-text-muted">
            <Money whole value={scenario.priceCents} /> · buying {formatIsoDate(scenario.purchaseDate, locale)} ·{" "}
            {scenario.ratePct}% interest
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <Button size="icon" variant="ghost" aria-label={`Edit ${scenario.name}`} onClick={onEdit}>
            <PencilIcon />
          </Button>
          <Button size="icon" variant="ghost" aria-label={`Duplicate ${scenario.name}`} onClick={onDuplicate}>
            <CopyIcon />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-text-muted hover:text-text"
            aria-label={`Delete ${scenario.name}`}
            onClick={onDelete}
          >
            <Trash2Icon />
          </Button>
        </div>
      </header>
      <ScenarioFigures scenario={scenario} evaluated={evaluated} payload={payload} />
      {scenario.note ? <p className="text-xs text-text-muted">{scenario.note}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editing a scenario
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   name: string, scheme: HouseScheme, price: string, purchaseDate: string,
 *   rate: string, childcare: string, cashMode: "projected" | "typed", cash: string,
 *   extraCash: string, lenderLimit: string, payChanges: Record<string, string>, note: string,
 * }} Draft
 */

/**
 * @param {Partial<HouseScenario> | null} from
 * @param {HousePayload} payload
 * @returns {Draft}
 */
function draftFrom(from, payload) {
  return {
    name: from?.name ?? "",
    scheme: from?.scheme ?? "first_home_guarantee",
    price: dollarsText(from?.priceCents),
    purchaseDate: from?.purchaseDate ?? "",
    rate: from?.ratePct != null ? String(from.ratePct) : "",
    childcare: dollarsText(from?.childcarePerMonthCents ?? 0),
    cashMode: from?.cashOverrideCents != null ? "typed" : "projected",
    cash: dollarsText(from?.cashOverrideCents),
    extraCash: dollarsText(from?.extraCashCents ?? 0),
    lenderLimit: dollarsText(from?.lenderLimitCents),
    payChanges: Object.fromEntries(
      payload.options.people.map((p) => [p.id, dollarsText(from?.payChanges?.[p.id] ?? 0)]),
    ),
    note: from?.note ?? "",
  };
}

/**
 * The draft as a scenario, or what's missing. The preview needs only the
 * fields a result can't be computed without; Save needs a name as well.
 *
 * @param {Draft} draft
 */
function parseDraft(draft) {
  /** @type {Record<string, string>} */
  const errors = {};
  const priceCents = centsOrNull(draft.price);
  if (priceCents === null || priceCents <= 0) errors.price = "Enter a price.";
  if (draft.purchaseDate === "") errors.purchaseDate = "Choose a date.";
  const rate = Number(draft.rate);
  if (draft.rate.trim() === "" || !Number.isFinite(rate)) errors.rate = "Enter an interest rate.";
  const lenderLimitCents = centsOrNull(draft.lenderLimit);
  if (draft.scheme === "help_to_buy" && (lenderLimitCents === null || lenderLimitCents <= 0)) {
    errors.lenderLimit = "Help to Buy needs your lender's borrowing limit.";
  }
  const cashOverrideCents = draft.cashMode === "typed" ? centsOrNull(draft.cash) : null;
  if (draft.cashMode === "typed" && cashOverrideCents === null) errors.cash = "Enter the cash you'll have.";

  /** @type {Record<string, Cents>} */
  const payChanges = {};
  for (const [personId, text] of Object.entries(draft.payChanges)) {
    const cents = centsOrNull(text) ?? 0;
    if (cents !== 0) payChanges[personId] = cents;
  }

  const computable = Object.keys(errors).length === 0;
  if (draft.name.trim() === "") errors.name = "Name the scenario.";

  /** @type {ScenarioFields | null} */
  const scenario = computable
    ? {
        name: draft.name.trim(),
        scheme: draft.scheme,
        priceCents: /** @type {Cents} */ (priceCents),
        purchaseDate: draft.purchaseDate,
        ratePct: rate,
        childcarePerMonthCents: Math.max(0, centsOrNull(draft.childcare) ?? 0),
        payChanges,
        cashOverrideCents,
        extraCashCents: centsOrNull(draft.extraCash) ?? 0,
        lenderLimitCents: draft.scheme === "help_to_buy" ? lenderLimitCents : null,
        note: draft.note.trim() === "" ? null : draft.note.trim(),
      }
    : null;
  return { scenario, errors };
}

/**
 * Add or edit a scenario, with the result beside the form as it's typed.
 *
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, payload: HousePayload,
 *   editingId: string | null, from: Partial<HouseScenario> | null, submitting: boolean,
 *   onSubmit: (scenario: ScenarioFields) => Promise<void>,
 * }} props
 */
function ScenarioSheet({ open, onOpenChange, payload, editingId, from, submitting, onSubmit }) {
  const { locale } = useSettings();
  const [draft, setDraft] = useState(() => draftFrom(from, payload));
  const [showErrors, setShowErrors] = useState(false);
  const [saveError, setSaveError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(from, payload));
    setShowErrors(false);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, from]);

  // Recomputed on every keystroke: a few hundred sums, well under a frame.
  const { scenario, errors } = parseDraft(draft);
  const evaluated = scenario ? evaluateScenario(payload, scenario) : null;
  const projected = draft.purchaseDate
    ? scenarioCash(payload, { purchaseDate: draft.purchaseDate, cashOverrideCents: null, extraCashCents: 0 }).projectedCents
    : null;

  /** @param {Partial<Draft>} patch */
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  /** @param {string} key */
  const err = (key) => (showErrors ? errors[key] : undefined);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setShowErrors(true);
    setSaveError(null);
    if (!scenario || errors.name) return;
    try {
      await onSubmit(scenario);
      onOpenChange(false);
    } catch (error) {
      setSaveError(/** @type {Error} */ (error).message);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" scrollable className="max-h-[92vh]">
        <div className="mx-auto w-full max-w-5xl">
          <SheetHeader>
            <SheetTitle>{editingId ? "Edit scenario" : "Add scenario"}</SheetTitle>
            <SheetDescription>
              A price, a scheme and a date, read against your budget after buying. The result updates as you type;
              nothing is saved until you say so.
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={handleSubmit} className="grid gap-6 px-4 pb-2 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <div className="flex flex-col gap-4">
              <FieldRow label="Name" htmlFor="scenario-name" required error={err("name")}>
                <Input
                  id="scenario-name"
                  value={draft.name}
                  placeholder="e.g. $650k in June"
                  aria-invalid={Boolean(err("name")) || undefined}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </FieldRow>
              <FieldRow label="Scheme" htmlFor="scenario-scheme">
                <Segmented
                  id="scenario-scheme"
                  ariaLabel="Scheme"
                  value={draft.scheme}
                  options={SCHEMES.map((value) => ({ value, label: SCHEME_LABELS[value] }))}
                  onChange={(scheme) => set({ scheme })}
                />
              </FieldRow>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldRow label="Price" htmlFor="scenario-price" required error={err("price")}>
                  <DollarField id="scenario-price" step={5000} value={draft.price} invalid={Boolean(err("price"))} onChange={(price) => set({ price })} />
                </FieldRow>
                <FieldRow label="Buying on" htmlFor="scenario-date" required error={err("purchaseDate")}>
                  <DatePicker id="scenario-date" value={draft.purchaseDate} onChange={(purchaseDate) => set({ purchaseDate })} placeholder="Choose a date" />
                </FieldRow>
                <FieldRow label="Interest rate" htmlFor="scenario-rate" required error={err("rate")} hint="A year, as the lender quotes it.">
                  <PercentField id="scenario-rate" value={draft.rate} invalid={Boolean(err("rate"))} onChange={(rate) => set({ rate })} />
                </FieldRow>
                <FieldRow label="Childcare a month" htmlFor="scenario-childcare" hint="Out of pocket, at today's pay.">
                  <DollarField id="scenario-childcare" value={draft.childcare} onChange={(childcare) => set({ childcare })} />
                </FieldRow>
              </div>
              {draft.scheme === "help_to_buy" ? (
                <FieldRow
                  label="Lender's borrowing limit"
                  htmlFor="scenario-limit"
                  required
                  error={err("lenderLimit")}
                  hint="From your broker. You borrow this much and the government's share fills the gap."
                >
                  <DollarField id="scenario-limit" step={5000} value={draft.lenderLimit} invalid={Boolean(err("lenderLimit"))} onChange={(lenderLimit) => set({ lenderLimit })} />
                </FieldRow>
              ) : null}
              <FieldRow
                label="Cash on the day"
                htmlFor="scenario-cash-mode"
                error={err("cash")}
                hint={
                  draft.cashMode === "projected" ? (
                    projected ? (
                      <>
                        <Money whole value={projected} /> by {formatIsoDate(draft.purchaseDate, locale)}, from today's
                        balances and what the allocation sends them each month.
                      </>
                    ) : (
                      "Choose a date to see what you'll have."
                    )
                  ) : (
                    "Your own figure, in place of the projection."
                  )
                }
              >
                <div className="flex flex-col gap-2">
                  <Segmented
                    id="scenario-cash-mode"
                    ariaLabel="Cash on the day"
                    value={draft.cashMode}
                    options={[
                      { value: "projected", label: "Projected" },
                      { value: "typed", label: "Type a figure" },
                    ]}
                    onChange={(cashMode) => set({ cashMode })}
                  />
                  {draft.cashMode === "typed" ? (
                    <DollarField id="scenario-cash" ariaLabel="Cash on the day" step={1000} value={draft.cash} invalid={Boolean(err("cash"))} onChange={(cash) => set({ cash })} />
                  ) : null}
                </div>
              </FieldRow>
              <FieldRow label="Extra cash" htmlFor="scenario-extra" hint="A gift, or a fund you'd redirect. Negative to hold some back.">
                <DollarField id="scenario-extra" signed step={1000} value={draft.extraCash} onChange={(extraCash) => set({ extraCash })} />
              </FieldRow>
              {payload.options.people.length > 0 ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  {payload.options.people.map((person) => (
                    <FieldRow
                      key={person.id}
                      label={`${person.name}'s pay change`}
                      htmlFor={`scenario-pay-${person.id}`}
                      hint={
                        person.id in payload.settings.grossByPerson
                          ? "A year before tax. Negative for part-time."
                          : "Add a salary in the budget settings first."
                      }
                    >
                      <DollarField
                        id={`scenario-pay-${person.id}`}
                        signed
                        step={1000}
                        value={draft.payChanges[person.id] ?? ""}
                        onChange={(text) => set({ payChanges: { ...draft.payChanges, [person.id]: text } })}
                      />
                    </FieldRow>
                  ))}
                </div>
              ) : null}
              <FieldRow label="Note" htmlFor="scenario-note" hint="Optional.">
                <Textarea id="scenario-note" rows={2} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
              </FieldRow>
            </div>

            <aside aria-label="Result" className="md:sticky md:top-0 md:self-start">
              <div className="rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card)">
                {scenario && evaluated ? (
                  <ScenarioFigures scenario={scenario} evaluated={evaluated} payload={payload} />
                ) : (
                  <p className="text-sm text-text-muted">Enter a price, a date and an interest rate to see what it costs.</p>
                )}
              </div>
            </aside>

            <SheetFooter className="px-0 md:col-span-2 md:flex-row md:justify-end">
              {saveError ? <InlineError>{saveError}</InlineError> : null}
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : editingId ? "Save scenario" : "Add scenario"}
              </Button>
            </SheetFooter>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The budget every scenario is read against
// ---------------------------------------------------------------------------

/**
 * @param {{ id: string, label: import("react").ReactNode, sub?: import("react").ReactNode, checked: boolean, onCheckedChange: (checked: boolean) => void }} props
 */
function SwitchRow({ id, label, sub, checked, onCheckedChange }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block truncate text-sm text-text">{label}</span>
        {sub ? <span className="block truncate text-xs text-text-muted">{sub}</span> : null}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </li>
  );
}

/**
 * @param {string[]} list
 * @param {string} id
 * @param {boolean} on
 */
function toggle(list, id, on) {
  return on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
}

/**
 * @param {{
 *   open: boolean, onOpenChange: (open: boolean) => void, payload: HousePayload,
 *   submitting: boolean, onSubmit: (settings: HouseSettings) => Promise<void>,
 * }} props
 */
function SettingsSheet({ open, onOpenChange, payload, submitting, onSubmit }) {
  const [draft, setDraft] = useState(payload.settings);
  const [gross, setGross] = useState(/** @type {Record<string, string>} */ ({}));
  const [owner, setOwner] = useState("");
  const [other, setOther] = useState("");
  const [saveError, setSaveError] = useState(/** @type {string | null} */ (null));
  const { options } = payload;

  useEffect(() => {
    if (!open) return;
    setDraft(payload.settings);
    setGross(Object.fromEntries(options.people.map((p) => [p.id, dollarsText(payload.settings.grossByPerson[p.id])])));
    setOwner(dollarsText(payload.settings.ownerCostsPerMonthCents));
    setOther(dollarsText(payload.settings.otherPurchaseCostsCents));
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Lines are kept by destination account, so two lines into one account
  // move together.
  const keptAccounts = new Set(draft.keepAccountIds);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setSaveError(null);
    /** @type {Record<string, Cents>} */
    const grossByPerson = {};
    for (const [personId, text] of Object.entries(gross)) {
      const cents = centsOrNull(text);
      if (cents !== null && cents > 0) grossByPerson[personId] = cents;
    }
    try {
      await onSubmit({
        ...draft,
        grossByPerson,
        ownerCostsPerMonthCents: Math.max(0, centsOrNull(owner) ?? 0),
        otherPurchaseCostsCents: Math.max(0, centsOrNull(other) ?? 0),
      });
      onOpenChange(false);
    } catch (error) {
      setSaveError(/** @type {Error} */ (error).message);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" scrollable className="max-h-[92vh]">
        <div className="mx-auto w-full max-w-3xl">
          <SheetHeader>
            <SheetTitle>Your budget after buying</SheetTitle>
            <SheetDescription>
              Every scenario is read against this. It changes nothing elsewhere in the app.
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={handleSubmit} className="flex flex-col gap-6 px-4 pb-2">
            <FieldRow label="Income after buying" htmlFor="house-variant" hint="The income variant you expect once you've moved in.">
              <Select
                value={draft.incomeVariantId ?? ""}
                onValueChange={(incomeVariantId) => setDraft((d) => ({ ...d, incomeVariantId }))}
              >
                <SelectTrigger id="house-variant" className="w-full">
                  <SelectValue placeholder="Choose an income variant" />
                </SelectTrigger>
                <SelectContent>
                  {options.variants.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} · <Money whole value={v.perMonthCents} cadence="mo" />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>

            <PageGroup title="Bills that stop when you buy">
              <ul className="divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
                {options.fixedCategories.map((c) => (
                  <SwitchRow
                    key={c.id}
                    id={`house-stop-${c.id}`}
                    label={c.name}
                    sub={<Money whole value={c.perMonthCents} cadence="mo" />}
                    checked={draft.stopCategoryIds.includes(c.id)}
                    onCheckedChange={(on) => setDraft((d) => ({ ...d, stopCategoryIds: toggle(d.stopCategoryIds, c.id, on) }))}
                  />
                ))}
              </ul>
            </PageGroup>

            <PageGroup title="Giving and saving that carry on">
              {options.lines.length === 0 ? (
                <p className="px-1 text-sm text-text-muted">
                  The chosen income has no active allocation plan, so there's nothing to carry on.
                </p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
                  {options.lines.map((line) => (
                    <SwitchRow
                      key={line.id}
                      id={`house-keep-${line.id}`}
                      label={line.label}
                      sub={
                        <>
                          {line.accountName} · {line.pct !== null ? `${line.pct}% of income` : <Money whole value={line.perMonthCents} cadence="mo" />}
                        </>
                      }
                      checked={keptAccounts.has(line.accountId)}
                      onCheckedChange={(on) =>
                        setDraft((d) => ({ ...d, keepAccountIds: toggle(d.keepAccountIds, line.accountId, on) }))
                      }
                    />
                  ))}
                </ul>
              )}
            </PageGroup>

            <PageGroup title="Cash for the deposit">
              <ul className="divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
                {options.cashAccounts.map((a) => (
                  <SwitchRow
                    key={a.id}
                    id={`house-cash-${a.id}`}
                    label={a.name}
                    sub={
                      <>
                        <Money whole value={a.balanceCents} /> today
                        {a.contributionPerMonthCents > 0 ? (
                          <>
                            {" · "}
                            <Money whole signed value={a.contributionPerMonthCents} cadence="mo" />
                          </>
                        ) : null}
                      </>
                    }
                    checked={draft.cashAccountIds.includes(a.id)}
                    onCheckedChange={(on) => setDraft((d) => ({ ...d, cashAccountIds: toggle(d.cashAccountIds, a.id, on) }))}
                  />
                ))}
              </ul>
            </PageGroup>

            <PageGroup title="Salaries before tax">
              <div className="grid gap-4 sm:grid-cols-2">
                {options.people.map((p) => (
                  <FieldRow key={p.id} label={p.name} htmlFor={`house-gross-${p.id}`} hint="A year. Only used to tax a pay change and for income caps.">
                    <DollarField
                      id={`house-gross-${p.id}`}
                      step={1000}
                      value={gross[p.id] ?? ""}
                      onChange={(text) => setGross((g) => ({ ...g, [p.id]: text }))}
                    />
                  </FieldRow>
                ))}
              </div>
            </PageGroup>

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow label="Owner costs a month" htmlFor="house-owner" hint="Council rates, building insurance, water service charges, upkeep.">
                <DollarField id="house-owner" value={owner} onChange={setOwner} />
              </FieldRow>
              <FieldRow label="Other purchase costs" htmlFor="house-other" hint="Conveyancing, building and pest, lender fees, moving.">
                <DollarField id="house-other" value={other} onChange={setOther} />
              </FieldRow>
            </div>

            <SheetFooter className="px-0 md:flex-row md:justify-end">
              {saveError ? <InlineError>{saveError}</InlineError> : null}
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Save"}
              </Button>
            </SheetFooter>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Where the figures come from
// ---------------------------------------------------------------------------

/** @param {{ payload: HousePayload }} props */
function Breakdown({ payload }) {
  const { locale } = useSettings();
  const { live, options, settings } = payload;
  const summary = houseSummary(payload);
  const stopping = options.fixedCategories.filter((c) => c.stops);
  const kept = options.lines.filter((l) => l.kept);
  const counted = options.cashAccounts.filter((a) => a.counted);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <PageGroup title="Each month after buying">
        <DataList>
          <DataListRow
            primary="Income"
            secondary={live.variant ? `${live.variant.name}, after tax` : "No income chosen yet"}
            trailing={<Money whole value={live.incomePerMonthCents} />}
          />
          <DataListRow
            primary="Bills"
            secondary={
              stopping.length > 0 ? (
                <>
                  {stopping.map((c) => c.name).join(", ")} {stopping.length === 1 ? "stops" : "stop"}
                  {" · "}
                  <Money whole value={live.billsNowPerMonthCents} /> a month today
                </>
              ) : (
                "Every current bill carries on"
              )
            }
            trailing={<Money whole value={-live.billsAfterPerMonthCents} />}
          />
          <DataListRow primary="Owner costs" secondary="Rates, insurance, upkeep" trailing={<Money whole value={-settings.ownerCostsPerMonthCents} />} />
          <DataListRow primary="Essentials" secondary="Your essential spending budgets" trailing={<Money whole value={-live.essentialsPerMonthCents} />} />
          {kept.map((line) => (
            <DataListRow
              key={line.id}
              primary={line.label}
              secondary={`${line.accountName}${line.pct !== null ? ` · ${line.pct}% of income` : ""}`}
              trailing={<Money whole value={-line.perMonthCents} />}
            />
          ))}
          <DataListRow primary="Good Life" secondary="Your non-essential budget, kept whole" trailing={<Money whole value={-live.goodLifePerMonthCents} />} />
          <DataListRow
            className="bg-surface-muted"
            primary="Room for a mortgage and childcare"
            trailing={<Money whole value={summary.roomPerMonthCents} className="font-semibold" />}
          />
        </DataList>
      </PageGroup>

      <PageGroup title="Cash for the deposit">
        <DataList>
          {counted.length === 0 ? (
            <DataListRow primary="No accounts chosen" secondary="Pick them in the budget settings" />
          ) : (
            counted.map((a) => (
              <DataListRow
                key={a.id}
                primary={a.name}
                secondary={
                  <>
                    {a.asAt ? formatIsoDate(a.asAt, locale) : "No balance recorded"}
                    {a.contributionPerMonthCents > 0 ? (
                      <>
                        {" · "}
                        <Money whole signed value={a.contributionPerMonthCents} cadence="mo" />
                      </>
                    ) : null}
                    {a.annualGrowthRate > 0 ? ` · ${pct(a.annualGrowthRate * 100, 1)}/yr` : ""}
                  </>
                }
                trailing={<Money whole value={a.balanceCents} />}
              />
            ))
          )}
          <DataListRow
            className="bg-surface-muted"
            primary="Today"
            secondary={live.contributionsFrom ? `Grows at today's ${live.contributionsFrom.name} allocation` : undefined}
            trailing={<Money whole value={summary.cashTodayCents} className="font-semibold" />}
          />
        </DataList>
      </PageGroup>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * Buying a house: what a price would cost up front and each month, against
 * the budget the household expects after buying. Like a goal, it reports —
 * nothing here writes an allocation, a balance or a budget, and every figure
 * is recomputed from the live budget on each visit.
 */
export function HousePage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const today = useTodayIso();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sheet, setSheet] = useState(
    /** @type {{ open: boolean, editingId: string | null, from: Partial<HouseScenario> | null }} */ ({
      open: false,
      editingId: null,
      from: null,
    }),
  );

  const houseQuery = useQuery(houseQueryOptions(today));
  const payload = houseQuery.data ?? null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["house"] });

  const saveSettings = useMutation({
    mutationFn: async (/** @type {HouseSettings} */ json) => {
      const res = await api.house.settings.$put({ json });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast.success("Budget after buying saved.");
    },
  });

  const saveScenario = useMutation({
    mutationFn: async (/** @type {{ id: string | null, json: ScenarioFields }} */ { id, json }) => {
      const res = id
        ? await api.house.scenarios[":id"].$patch({ param: { id }, json })
        : await api.house.scenarios.$post({ json });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: (_data, { id }) => {
      invalidate();
      toast.success(id ? "Scenario saved." : "Scenario added.");
    },
  });

  const deleteScenario = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api.house.scenarios[":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast.success("Scenario deleted.");
    },
    onError: (error) => toast.error(error.message),
  });

  const evaluated = useMemo(
    () =>
      payload ? new Map(payload.scenarios.map((s) => [s.id, evaluateScenario(payload, s)])) : new Map(),
    [payload],
  );

  /** @param {Partial<HouseScenario> | null} from @param {string | null} [editingId] */
  const openSheet = (from, editingId = null) => setSheet({ open: true, editingId, from });
  // A new scenario starts from the last one's rate, date and childcare —
  // they rarely differ between the prices being compared.
  const latest = payload?.scenarios.at(-1) ?? null;
  const addScenario = () =>
    openSheet(
      latest
        ? {
            purchaseDate: latest.purchaseDate,
            ratePct: latest.ratePct,
            childcarePerMonthCents: latest.childcarePerMonthCents,
          }
        : null,
    );

  useEffect(
    () =>
      registerCommands([
        { id: "house:add", group: "Actions", label: "Add house scenario", icon: HouseIcon, run: () => addScenario() },
        {
          id: "house:settings",
          group: "Actions",
          label: "Budget after buying",
          icon: SlidersHorizontalIcon,
          run: () => setSettingsOpen(true),
        },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [latest?.id],
  );

  const summary = payload ? houseSummary(payload) : null;

  return (
    <>
      <PageHeader
        title="Goals"
        description="What a home would cost up front and each month, against the budget you'll have after buying. It reports — nothing here changes your budget."
        actions={
          <>
            <Button variant="outline" onClick={() => setSettingsOpen(true)} disabled={!payload}>
              <SlidersHorizontalIcon />
              Budget after buying
            </Button>
            <Button onClick={addScenario} disabled={!payload}>
              <PlusIcon />
              Add scenario
            </Button>
          </>
        }
      />

      <GoalsTabs />

      {houseQuery.isLoading ? (
        <CardsSkeleton cards={3} height={420} label="Loading house scenarios" />
      ) : houseQuery.isError ? (
        <QueryError error={houseQuery.error} onRetry={() => houseQuery.refetch()} what="your house scenarios" />
      ) : payload && summary ? (
        <>
          {payload.warnings.length > 0 ? (
            <NoticeList items={payload.warnings.map((w) => ({ key: w.code, content: w.message }))} />
          ) : null}

          <StatGroup aria-label="Budget after buying">
            <Stat
              label="Income after buying"
              value={<Money whole value={payload.live.incomePerMonthCents} />}
              hint={payload.live.variant ? `${payload.live.variant.name}, after tax, a month` : "Choose it in Budget after buying"}
            />
            <Stat
              label="Already spoken for"
              value={<Money whole value={summary.spokenForPerMonthCents} />}
              hint="Bills, owner costs, essentials, and the giving and saving that carry on"
            />
            <Stat
              label="Good Life"
              value={<Money whole value={payload.live.goodLifePerMonthCents} />}
              hint="Your non-essential budget, kept whole"
            />
            <Stat
              tone={summary.roomPerMonthCents <= 0 ? "attention" : "default"}
              label="Room for a mortgage"
              value={<Money whole value={summary.roomPerMonthCents} />}
              hint="A month, for the repayment and childcare together"
            />
          </StatGroup>

          <PageSection
            title="Scenarios"
            description={
              <>
                Each is a price, a scheme and a date. Cash today is <Money whole value={summary.cashTodayCents} />
                {summary.cashPerMonthCents > 0 ? (
                  <>
                    , growing <Money whole value={summary.cashPerMonthCents} /> a month
                  </>
                ) : null}
                .
              </>
            }
          >
            {payload.scenarios.length === 0 ? (
              <EmptyState
                icon={HouseIcon}
                title="No scenarios yet"
                description="Add a price, a scheme and a date to see the repayment, what's spare each month, and what it would take to make it work."
                action={
                  <Button onClick={addScenario}>
                    <PlusIcon />
                    Add scenario
                  </Button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-6 xl:grid-cols-3">
                {payload.scenarios.map((s) => {
                  const e = evaluated.get(s.id);
                  if (!e) return null;
                  return (
                    <ScenarioCard
                      key={s.id}
                      scenario={s}
                      evaluated={e}
                      payload={payload}
                      onEdit={() => openSheet(s, s.id)}
                      onDuplicate={() => openSheet({ ...s, name: `${s.name} (copy)` })}
                      onDelete={async () => {
                        const ok = await confirm({
                          title: `Delete "${s.name}"?`,
                          description: "The scenario goes. Your budget, balances and other scenarios aren't touched.",
                          confirmLabel: "Delete",
                        });
                        if (ok) deleteScenario.mutate(s.id);
                      }}
                    />
                  );
                })}
              </div>
            )}
          </PageSection>

          <PageSection
            title="Where these figures come from"
            description="Read live from Income, Fixed Costs, Variable Costs, Allocation and Accounts each time you open this page."
            actions={
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                <SlidersHorizontalIcon />
                Change
              </Button>
            }
          >
            <Breakdown payload={payload} />
          </PageSection>

          <p className="px-1 text-xs text-pretty text-text-subtle">
            Rules as at July 2026: Victorian first-home stamp duty (nil to $600k, tapering to full duty at $750k), the
            $950k Melbourne price caps for the 5% deposit scheme and Help to Buy, Help to Buy's $165k couple income cap
            and 5–30% share, 2026-27 tax rates with the Medicare levy, and the childcare subsidy taper. Not included:
            HELP debt repayments, mortgage insurance, the first home owner grant, or any change in the home's value.
            Check anything you'd act on with your broker.
          </p>

          <ScenarioSheet
            open={sheet.open}
            onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
            payload={payload}
            editingId={sheet.editingId}
            from={sheet.from}
            submitting={saveScenario.isPending}
            onSubmit={async (json) => {
              await saveScenario.mutateAsync({ id: sheet.editingId, json });
            }}
          />
          <SettingsSheet
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            payload={payload}
            submitting={saveSettings.isPending}
            onSubmit={async (settings) => {
              await saveSettings.mutateAsync(settings);
            }}
          />
        </>
      ) : null}
    </>
  );
}
