import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { addDaysIso, projectPaydays } from "@budget/engine";
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  CalendarRangeIcon,
  CopyIcon,
  GitCompareIcon,
  PlusIcon,
  Trash2Icon,
  WalletIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.jsx";
import { Switch } from "@/components/ui/switch.jsx";
import { Textarea } from "@/components/ui/textarea.jsx";
import { DataList, DataListRow } from "@/components/data-list.jsx";
import { DatePicker } from "@/components/date-picker.jsx";
import { Delta } from "@/components/delta.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { CardsSkeleton, ListSkeleton, PanelSkeleton } from "@/components/loading.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { EDITABLE_GROUP, InlineMoney, InlineSelect, InlineText } from "@/components/inline-edit.jsx";
import { MoneyInput } from "@/components/money-input.jsx";
import { Money } from "@/components/money.jsx";
import { InlineError, Notice } from "@/components/notice.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { PageSection } from "@/components/page-section.jsx";
import { QueryError } from "@/components/query-error.jsx";
import { useConfirm } from "@/components/confirm-dialog.jsx";
import { api } from "@/lib/api.js";
import { readApiError } from "@/lib/api-error.js";
import { registerCommands } from "@/lib/commands.js";
import { CADENCES, CADENCE_LABELS } from "@/lib/constants.js";
import { formatIsoDate, todayIso } from "@/lib/dates.js";
import { colorFor, entityColors } from "@/lib/entity-colors.js";
import { useSettings } from "@/lib/settings.jsx";
import { cn } from "@/lib/utils.js";
import {
  incomeResolveQueryOptions,
  incomeVariantsQueryOptions,
  paySchedulesQueryOptions,
  peopleQueryOptions,
  variantScheduleQueryOptions,
} from "@/lib/queries.js";

/** @import { Cadence, Cents } from "@budget/engine" */
/** @typedef {{ id: string, name: string }} Person */
/** @typedef {{ perPay: Cents | null, perMonth: Cents, perYear: Cents }} CadenceTotals */
/** @typedef {{ id: string, variantId: string, personId: string, label: string | null, amountCents: Cents, cadence: Cadence, notes: string | null, sortOrder: number }} IncomeLine */
/** @typedef {{ id: string, name: string, notes: string | null, sortOrder: number, lines: IncomeLine[], totals: { perPersonCents: Record<string, CadenceTotals>, totalCents: CadenceTotals } }} IncomeVariant */
/** @typedef {{ id: string, variantId: string, startsOn: string, endsOn: string | null, notes: string | null }} ScheduleEntry */
/** @typedef {{ kind: "overlap", variantIds: string[], from: string, to: string } | { kind: "gap", from: string, to: string }} VariantDiagnostic */
/** @typedef {{ variantId: string | null, variant: IncomeVariant | null, diagnostics: VariantDiagnostic[] }} ResolveResult */
/** @typedef {{ name: string, notes: string | null }} VariantFormData */
/** @typedef {{ personId: string, label: string | null, amountCents: Cents, cadence: Cadence, notes: string | null }} IncomeLineFormData */
/** @typedef {{ variantId: string, startsOn: string, endsOn: string | null, notes: string | null }} ScheduleFormData */

/** @param {Person[]} people @param {string} personId */
function personName(people, personId) {
  return people.find((p) => p.id === personId)?.name ?? "Unknown person";
}

/**
 * Why something that belongs to a person can't be added yet, and the way
 * forward — said on the page, where a phone can read it. First run only:
 * the household's people are added under Admin.
 *
 * @param {{ what: string }} props `what` — the plural thing being blocked ("Pay schedules").
 */
function NoPeopleNotice({ what }) {
  return (
    <Notice>
      {what} belong to a person, and there&apos;s no one in the household yet.{" "}
      <Button asChild variant="link" className="h-auto p-0 align-baseline">
        <Link to="/admin/people">Add the people in your household</Link>
      </Button>{" "}
      first.
    </Notice>
  );
}

/** @param {IncomeVariant[]} variants @param {string} variantId */
function variantName(variants, variantId) {
  return variants.find((v) => v.id === variantId)?.name ?? "Unknown variant";
}

// UI-only calendar arithmetic for the schedule timeline's display window —
// not a business calculation, so plain `Date` math is fine here the same way
// lib/dates.js already uses it (packages/engine never calls `new Date()`
// itself; every engine caller passes `today` in).
/** @param {number} ms */
function msToIso(ms) {
  const date = new Date(ms);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** @param {string} iso */
function isoToMs(iso) {
  return new Date(`${iso}T00:00:00`).getTime();
}

/**
 * Pairwise interval overlap on real (unclamped) date ranges — an open
 * `endsOn` is treated as +Infinity. Used to flag which schedule entries
 * collide, independent of whichever window the timeline happens to display.
 *
 * @param {ScheduleEntry[]} entries
 */
function computeOverlappingIds(entries) {
  /** @type {Set<string>} */
  const overlapping = new Set();
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = /** @type {ScheduleEntry} */ (entries[i]);
      const b = /** @type {ScheduleEntry} */ (entries[j]);
      const aStart = isoToMs(a.startsOn);
      const aEnd = a.endsOn ? isoToMs(a.endsOn) : Number.POSITIVE_INFINITY;
      const bStart = isoToMs(b.startsOn);
      const bEnd = b.endsOn ? isoToMs(b.endsOn) : Number.POSITIVE_INFINITY;
      if (aStart < bEnd && bStart < aEnd) {
        overlapping.add(a.id);
        overlapping.add(b.id);
      }
    }
  }
  return overlapping;
}

/**
 * Stretches of `[windowStartMs, windowEndMs)` no entry covers — standard
 * merge-intervals-then-complement, clipped to the display window.
 *
 * @param {ScheduleEntry[]} entries
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 */
function computeGaps(entries, windowStartMs, windowEndMs) {
  const clipped = entries
    .map((e) => {
      const start = Math.max(isoToMs(e.startsOn), windowStartMs);
      const end = Math.min(e.endsOn ? isoToMs(e.endsOn) : windowEndMs, windowEndMs);
      return /** @type {[number, number]} */ ([start, end]);
    })
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  /** @type {[number, number][]} */
  const gaps = [];
  let cursor = windowStartMs;
  for (const [start, end] of clipped) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < windowEndMs) gaps.push([cursor, windowEndMs]);
  return gaps;
}

/**
 * Label + dominant figure for one of the three cadence columns every totals
 * display uses — variant cards, the detail sheet, the active-variant banner.
 *
 * @param {{ label: string, value: Cents | null }} props
 */
function TotalCell({ label, value }) {
  // Figure pinned to the bottom of the cell: "Per pay (Fortnightly)" wraps to
  // two lines in a narrow card and "Per month" doesn't, and the three figures
  // should still read across as one row.
  return (
    <div className="flex flex-col justify-between gap-0.5">
      <p className="text-xs text-text-subtle">{label}</p>
      <p className="font-semibold text-text tabular-nums">{value != null ? <Money value={value} /> : "—"}</p>
    </div>
  );
}

/**
 * @param {{ totals: { perPersonCents: Record<string, CadenceTotals>, totalCents: CadenceTotals }, payCadenceLabel: string | null }} props
 */
function TotalsRow({ totals, payCadenceLabel }) {
  return (
    <div className="mt-auto grid grid-cols-3 gap-2 border-t border-border pt-3">
      <TotalCell label={`Per pay${payCadenceLabel ? ` (${payCadenceLabel})` : ""}`} value={totals.totalCents.perPay} />
      <TotalCell label="Per month" value={totals.totalCents.perMonth} />
      <TotalCell label="Per year" value={totals.totalCents.perYear} />
    </div>
  );
}

/**
 * Resolves today's variant and shows its total per pay period as the
 * dominant figure — or a warning naming the conflict when the schedule
 * doesn't resolve cleanly (phases/05-income.md "Active variant banner").
 * `override` is a URL lens (not a stored fact) letting the operator view a
 * different variant's totals without changing what "today" resolves to.
 *
 * @param {{
 *   resolution: { variantId: string | null, variant: IncomeVariant | null, diagnostics: VariantDiagnostic[] } | undefined,
 *   isLoading: boolean,
 *   variants: IncomeVariant[],
 *   payCadenceLabel: string | null,
 *   override: IncomeVariant | null,
 *   onClearOverride: () => void,
 * }} props
 */
function ActiveVariantBanner({ resolution, isLoading, variants, payCadenceLabel, override, onClearOverride }) {
  if (isLoading) {
    // The card itself stays still and only its lines pulse, the same as every
    // other placeholder: a whole white card pulsing on a near-white page read
    // as an empty card rather than one on its way.
    return (
      <div
        aria-busy="true"
        className="flex h-24 flex-col justify-center gap-2 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5"
      >
        <span className="sr-only">Loading today&apos;s income</span>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-64 max-w-full" />
      </div>
    );
  }

  const diagnostic = resolution?.diagnostics[0] ?? null;
  const shown = override ?? resolution?.variant ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
      {diagnostic ? (
        <Notice>
          <p>
            {diagnostic.kind === "overlap" ? (
              <>
                Overlapping variants today:{" "}
                <strong>{diagnostic.variantIds.map((id) => variantName(variants, id)).join(" and ")}</strong> both
                cover {formatIsoDate(diagnostic.from, "en-AU")} – {formatIsoDate(diagnostic.to, "en-AU")}. No variant
                is confidently active.
              </>
            ) : (
              <>
                No variant covers today ({formatIsoDate(diagnostic.from, "en-AU")} –{" "}
                {formatIsoDate(diagnostic.to, "en-AU")}). Add a schedule entry to close the gap.
              </>
            )}
          </p>
        </Notice>
      ) : null}

      {override ? (
        <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
          <span>
            Viewing <strong className="text-text">{override.name}</strong> — not today&apos;s resolved variant.
          </span>
          <Button size="sm" variant="ghost" onClick={onClearOverride}>
            View today
          </Button>
        </div>
      ) : null}

      {shown ? (
        // The variant's name belongs to the figure: on desktop it used to sit
        // at the far right edge of the card, 900px from the number it names.
        <div className="flex flex-col gap-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium tracking-wide text-text-subtle uppercase">
            {override ? "Viewing" : "Active today"}
            <span className="text-sm font-semibold tracking-normal text-text normal-case">{shown.name}</span>
          </p>
          <div>
            <p className="text-3xl font-bold tracking-tight text-text tabular-nums">
              {shown.totals.totalCents.perPay != null ? (
                <Money value={shown.totals.totalCents.perPay} />
              ) : (
                <Money value={shown.totals.totalCents.perMonth} />
              )}
              <span className="ml-1.5 text-base font-medium text-text-muted">
                {shown.totals.totalCents.perPay != null ? `per pay (${payCadenceLabel})` : "per month"}
              </span>
            </p>
          </div>
        </div>
      ) : (
        <EmptyState
          icon={WalletIcon}
          title="No variant is active"
          description="Add a schedule entry covering today, or create an income variant to get started."
        />
      )}
    </div>
  );
}

/**
 * Adding only — an existing variant's name and notes are edited on its card.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   submitting: boolean,
 *   onSubmit: (data: VariantFormData) => Promise<void>,
 * }} props
 */
function VariantFormDialog({ open, onOpenChange, submitting, onSubmit }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setName("");
    setNotes("");
    setError(null);
  }, [open]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    try {
      await onSubmit({ name: name.trim(), notes: notes.trim() || null });
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add income variant</DialogTitle>
          <DialogDescription>
            A named income scenario — "Usual", "PL Gov (High)" — with its own set of lines.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <FieldRow label="Name" htmlFor="variant-name" required>
            <Input id="variant-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </FieldRow>
          <FieldRow label="Notes" htmlFor="variant-notes" hint="Optional — context worth keeping, e.g. scheme details.">
            <Textarea id="variant-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </FieldRow>
          {error ? <InlineError>{error}</InlineError> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Adding only — an existing line is edited where it sits on its card.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   people: Person[],
 *   submitting: boolean,
 *   onSubmit: (data: IncomeLineFormData) => Promise<void>,
 * }} props
 */
function IncomeLineFormDialog({ open, onOpenChange, people, submitting, onSubmit }) {
  const [personId, setPersonId] = useState("");
  const [label, setLabel] = useState("");
  const [amountCents, setAmountCents] = useState(/** @type {number | null} */ (null));
  const [cadence, setCadence] = useState(/** @type {Cadence} */ ("fortnightly"));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setPersonId(people[0]?.id ?? "");
    setLabel("");
    setAmountCents(null);
    setCadence("fortnightly");
    setNotes("");
    setError(null);
  }, [open, people]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!personId) {
      setError("Choose a person.");
      return;
    }
    if (amountCents === null) {
      setError("Enter an amount.");
      return;
    }
    try {
      await onSubmit({
        personId,
        label: label.trim() || null,
        amountCents,
        cadence,
        notes: notes.trim() || null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add income line</DialogTitle>
          <DialogDescription>One person's income within this variant.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {people.length === 0 ? <NoPeopleNotice what="Income lines" /> : null}
          <FieldRow label="Person" htmlFor="line-person">
            <Select value={personId} onValueChange={setPersonId}>
              <SelectTrigger id="line-person" className="w-full">
                <SelectValue placeholder="Choose a person" />
              </SelectTrigger>
              <SelectContent>
                {people.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Label" htmlFor="line-label" hint='Optional — e.g. "Salary", "Gov PPL".'>
            <Input id="line-label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </FieldRow>
          <FieldRow label="Amount" htmlFor="line-amount" required hint="After tax.">
            <MoneyInput id="line-amount" value={amountCents} onChange={setAmountCents} />
          </FieldRow>
          <FieldRow label="Cadence" htmlFor="line-cadence">
            <Select value={cadence} onValueChange={(value) => setCadence(/** @type {Cadence} */ (value))}>
              <SelectTrigger id="line-cadence" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Notes" htmlFor="line-notes" hint="Optional.">
            <Textarea id="line-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </FieldRow>
          {error ? <InlineError>{error}</InlineError> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting || people.length === 0}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   entry: ScheduleEntry | null,
 *   variants: IncomeVariant[],
 *   submitting: boolean,
 *   onSubmit: (data: ScheduleFormData) => Promise<void>,
 *   onDelete: (() => void) | null,
 * }} props
 */
function ScheduleEntryFormDialog({ open, onOpenChange, entry, variants, submitting, onSubmit, onDelete }) {
  const { locale } = useSettings();
  const [variantId, setVariantId] = useState("");
  const [startsOn, setStartsOn] = useState(todayIso());
  const [openEnded, setOpenEnded] = useState(true);
  const [endsOn, setEndsOn] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setVariantId(entry?.variantId ?? variants[0]?.id ?? "");
    setStartsOn(entry?.startsOn ?? todayIso());
    setOpenEnded(entry ? entry.endsOn === null : true);
    setEndsOn(entry?.endsOn ?? todayIso());
    setNotes(entry?.notes ?? "");
    setError(null);
  }, [open, entry, variants]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!variantId) {
      setError("Choose a variant.");
      return;
    }
    if (!openEnded && endsOn <= startsOn) {
      setError("End date must be after the start date.");
      return;
    }
    // Always includes `variantId`, even when editing — the PATCH schema
    // (zod/variant-schedule.js) has no such field, so Zod's default "strip
    // unknown keys" behaviour drops it there; uniform shape here means one
    // `ScheduleFormData` type instead of a create/update union.
    const data = { variantId, startsOn, endsOn: openEnded ? null : endsOn, notes: notes.trim() || null };
    try {
      await onSubmit(data);
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? "Edit schedule entry" : "Add schedule entry"}</DialogTitle>
          <DialogDescription>Tells the app which variant is active over this date range.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!entry ? (
            <FieldRow label="Variant" htmlFor="entry-variant">
              <Select value={variantId} onValueChange={setVariantId}>
                <SelectTrigger id="entry-variant" className="w-full">
                  <SelectValue placeholder="Choose a variant" />
                </SelectTrigger>
                <SelectContent>
                  {variants.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          ) : (
            <p className="text-sm text-text-muted">{variantName(variants, entry.variantId)}</p>
          )}
          <FieldRow label="Starts on" htmlFor="entry-starts">
            <DatePicker id="entry-starts" value={startsOn} onChange={setStartsOn} />
          </FieldRow>
          <FieldRow
            label="Open-ended"
            htmlFor="entry-open-ended"
            hint='"This variant, from here on." Turn off to set an end date.'
          >
            <Switch id="entry-open-ended" checked={openEnded} onCheckedChange={setOpenEnded} />
          </FieldRow>
          {/* "Ends on" is exclusive — the variant stops at the start of that
              day — but reads as inclusive, so "ends 30 Jun" beside "starts
              1 Jul" quietly left 30 June with no variant at all. The hint
              names the last day actually covered, and how to hand over. */}
          {!openEnded ? (
            <FieldRow
              label="Ends on"
              htmlFor="entry-ends"
              hint={
                <>
                  Not included: this variant stops at the start of that day.
                  {endsOn > startsOn ? ` Last day covered: ${formatIsoDate(addDaysIso(endsOn, -1), locale)}.` : ""} To hand
                  over without a gap, use the next entry&apos;s start date here.
                </>
              }
            >
              <DatePicker id="entry-ends" value={endsOn} onChange={setEndsOn} />
            </FieldRow>
          ) : null}
          <FieldRow label="Notes" htmlFor="entry-notes" hint="Optional.">
            <Textarea id="entry-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </FieldRow>
          {error ? <InlineError>{error}</InlineError> : null}
          <DialogFooter className={onDelete ? "sm:justify-between!" : undefined}>
            {onDelete ? (
              <Button type="button" variant="ghost" className="text-text-muted hover:text-text" onClick={onDelete}>
                Delete
              </Button>
            ) : null}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Fixed three-letter names rather than Intl: en-AU's "short" month is
// "June", "July", "Sept", which won't sit in a column of "Jan", "Feb", "Mar".
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * One column per calendar month inside the window, for the axis and grid.
 *
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 */
function monthColumns(windowStartMs, windowEndMs) {
  const first = new Date(windowStartMs);
  /** @type {{ startMs: number, endMs: number, year: number, label: string }[]} */
  const columns = [];
  let y = first.getFullYear();
  let m = first.getMonth();
  while (new Date(y, m, 1).getTime() < windowEndMs) {
    columns.push({
      startMs: new Date(y, m, 1).getTime(),
      endMs: new Date(y, m + 1, 1).getTime(),
      year: y,
      label: /** @type {string} */ (MONTH_ABBR[m]),
    });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return columns;
}

/**
 * Greedy interval packing: an entry joins the first lane whose last entry has
 * already ended, so a clean hand-over schedule reads as one continuous row and
 * only genuine overlaps push an entry down to a second lane.
 *
 * @param {ScheduleEntry[]} sorted entries ordered by `startsOn`
 */
function packLanes(sorted) {
  /** @type {number[]} */
  const laneEnds = [];
  /** @type {ScheduleEntry[][]} */
  const lanes = [];
  for (const entry of sorted) {
    const start = isoToMs(entry.startsOn);
    const end = entry.endsOn ? isoToMs(entry.endsOn) : Number.POSITIVE_INFINITY;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      lanes.push([]);
    }
    laneEnds[lane] = end;
    /** @type {ScheduleEntry[]} */ (lanes[lane]).push(entry);
  }
  return lanes;
}

/** @param {ScheduleEntry} entry */
function entryRangeLabel(entry) {
  return entry.endsOn
    ? `${formatIsoDate(entry.startsOn, "en-AU")} – ${formatIsoDate(entry.endsOn, "en-AU")}`
    : `From ${formatIsoDate(entry.startsOn, "en-AU")}, open-ended`;
}

/**
 * Month-by-month roadmap of the schedule: entries packed into as few lanes as
 * possible and coloured by variant, the past faded behind a full-height Today
 * line. Overlaps ring amber; stretches from today on that no entry covers are
 * hatched and named — the operator should see a bad schedule, not read about
 * it (phases/05-income.md "Schedule timeline"). Gaps before today aren't
 * flagged: nothing projects from them, so they'd be noise to act on.
 *
 * @param {{ entries: ScheduleEntry[], variants: IncomeVariant[], onEditEntry: (entry: ScheduleEntry) => void }} props
 */
function ScheduleTimelineDesktop({ entries, variants, onEditEntry }) {
  const { today, windowStartMs, windowEndMs } = useMemo(() => {
    const now = new Date();
    return {
      today: todayIso(),
      windowStartMs: new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime(),
      windowEndMs: new Date(now.getFullYear(), now.getMonth() + 16, 1).getTime(),
    };
  }, []);
  const span = windowEndMs - windowStartMs;
  const todayMs = isoToMs(today);

  /** @param {number} ms */
  const pct = (ms) => ((Math.min(Math.max(ms, windowStartMs), windowEndMs) - windowStartMs) / span) * 100;
  const todayPct = pct(todayMs);

  const columns = useMemo(() => monthColumns(windowStartMs, windowEndMs), [windowStartMs, windowEndMs]);
  const years = useMemo(() => {
    /** @type {{ year: number, startMs: number, endMs: number }[]} */
    const out = [];
    for (const col of columns) {
      const last = out[out.length - 1];
      if (last && last.year === col.year) last.endMs = col.endMs;
      else out.push({ year: col.year, startMs: col.startMs, endMs: col.endMs });
    }
    return out;
  }, [columns]);
  const overlapping = useMemo(() => computeOverlappingIds(entries), [entries]);
  const gaps = useMemo(() => computeGaps(entries, todayMs, windowEndMs), [entries, todayMs, windowEndMs]);
  const variantColors = useMemo(() => entityColors(variants.map((v) => v.id)), [variants]);
  const lanes = useMemo(() => {
    const visible = entries
      .filter((e) => isoToMs(e.startsOn) < windowEndMs && (!e.endsOn || isoToMs(e.endsOn) > windowStartMs))
      .sort((a, b) => a.startsOn.localeCompare(b.startsOn));
    return packLanes(visible);
  }, [entries, windowStartMs, windowEndMs]);

  return (
    <div
      role="group"
      aria-label="Variant schedule timeline"
      className="rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)"
    >
      <div aria-hidden="true" className="relative h-5 text-xs font-medium text-text">
        {years.map((y) => (
          <span
            key={y.year}
            className="absolute top-0 overflow-hidden pl-1.5 whitespace-nowrap"
            style={{ left: `${pct(y.startMs)}%`, width: `${pct(y.endMs) - pct(y.startMs)}%` }}
          >
            {y.year}
          </span>
        ))}
      </div>

      <div className="relative">
        {/* Month grid behind everything; year boundaries a step stronger. */}
        {columns.slice(1).map((col) => (
          <div
            key={col.startMs}
            aria-hidden="true"
            className={cn("absolute inset-y-0 w-px", new Date(col.startMs).getMonth() === 0 ? "bg-border-strong" : "bg-border/60")}
            style={{ left: `${pct(col.startMs)}%` }}
          />
        ))}

        <div aria-hidden="true" className="relative h-6 border-b border-border text-[0.6875rem] text-text-subtle">
          {columns.map((col) => (
            <span
              key={col.startMs}
              className={cn(
                "absolute inset-y-0 flex items-center justify-center",
                todayMs >= col.startMs && todayMs < col.endMs && "font-semibold text-accent-brand",
              )}
              style={{ left: `${pct(col.startMs)}%`, width: `${pct(col.endMs) - pct(col.startMs)}%` }}
            >
              {col.label}
            </span>
          ))}
        </div>

        <div className="relative py-3">
          {gaps.map(([gStart, gEnd], i) => {
            const width = pct(gEnd) - pct(gStart);
            return (
              <div
                key={i}
                className="absolute inset-y-1.5 overflow-hidden rounded-md border border-dashed border-warning-strong/50 px-2 pt-1 text-xs font-medium whitespace-nowrap text-warning-strong"
                style={{
                  left: `${pct(gStart)}%`,
                  width: `${Math.max(width, 0.4)}%`,
                  backgroundImage:
                    "repeating-linear-gradient(135deg, var(--warning-soft) 0 6px, transparent 6px 12px)",
                }}
                title={`No variant in effect from ${formatIsoDate(msToIso(gStart), "en-AU")}${gEnd >= windowEndMs ? " onwards" : ` to ${formatIsoDate(msToIso(gEnd), "en-AU")}`}`}
              >
                {width >= 10 ? "No variant in effect" : null}
              </div>
            );
          })}

          <div className="relative flex flex-col gap-1.5">
            {(lanes.length ? lanes : [[]]).map((lane, laneIndex) => (
              <div key={laneIndex} className="relative h-10">
                {lane.map((entry) => {
                  const startMs = isoToMs(entry.startsOn);
                  const endMs = entry.endsOn ? isoToMs(entry.endsOn) : Number.POSITIVE_INFINITY;
                  const left = pct(startMs);
                  const right = pct(endMs);
                  const width = Math.max(right - left, 1.2);
                  const runsOffLeft = startMs < windowStartMs;
                  const runsOffRight = endMs > windowEndMs;
                  // A bar that spans today starts its label just past the
                  // Today line: that's where the eye is, and the line would
                  // otherwise strike through the text.
                  const labelAfterToday = startMs < todayMs && endMs > todayMs && right - todayPct >= 15;
                  const color = colorFor(variantColors, entry.variantId);
                  const name = variantName(variants, entry.variantId);
                  const fades = [
                    runsOffLeft ? "transparent 0, black 3rem" : "black 0",
                    runsOffRight ? "black calc(100% - 4rem), transparent 100%" : "black 100%",
                  ].join(", ");
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => onEditEntry(entry)}
                      className={cn(
                        "absolute inset-y-0 flex items-center gap-2 overflow-hidden rounded-md border border-(--bar-edge) bg-(--bar-fill) text-left text-xs text-text transition-colors hover:bg-(--bar-hover) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        runsOffLeft && "rounded-l-none border-l-0",
                        runsOffRight && "rounded-r-none border-r-0",
                        overlapping.has(entry.id) && "ring-2 ring-warning-strong ring-offset-1 ring-offset-surface",
                      )}
                      style={/** @type {import("react").CSSProperties} */ ({
                        left: `${left}%`,
                        width: `${width}%`,
                        paddingLeft: labelAfterToday ? `calc(${((todayPct - left) / width) * 100}% + 0.625rem)` : "0.625rem",
                        paddingRight: "0.625rem",
                        // Mixed into the surface rather than transparent, so
                        // the grid passes behind the band instead of through
                        // its label, and both themes stay legible without a
                        // hardcoded text colour fighting the fill.
                        "--bar-fill": `color-mix(in oklch, ${color} 18%, var(--surface))`,
                        "--bar-hover": `color-mix(in oklch, ${color} 28%, var(--surface))`,
                        "--bar-edge": `color-mix(in oklch, ${color} 45%, var(--surface))`,
                        maskImage: runsOffLeft || runsOffRight ? `linear-gradient(to right, ${fades})` : undefined,
                      })}
                      title={`${name} · ${entryRangeLabel(entry)}`}
                    >
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                      <span className="max-w-[70%] shrink-0 truncate font-medium">{name}</span>
                      {overlapping.has(entry.id) ? (
                        <AlertTriangleIcon className="size-3.5 shrink-0 text-warning-strong" aria-label="Overlaps another entry" />
                      ) : null}
                      <span className="min-w-0 truncate text-text-muted">{entryRangeLabel(entry)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* The past, faded: a wash over bars and grid alike, so history reads
            as settled and the eye lands on today onwards. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 z-10 bg-surface/50"
          style={{ width: `${todayPct}%` }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-6 bottom-0 z-20 w-0.5 -translate-x-1/2 rounded-full bg-accent-brand"
          style={{ left: `${todayPct}%` }}
        />
      </div>

      <div className="relative h-5">
        <span
          className="absolute top-0 -translate-x-1/2 rounded-full bg-accent-brand px-2 text-[0.6875rem] leading-5 font-medium whitespace-nowrap text-accent-brand-fg"
          style={{ left: `${todayPct}%` }}
        >
          Today · {formatIsoDate(today, "en-AU")}
        </span>
      </div>
    </div>
  );
}

/**
 * Mobile answer to the Gantt above: the same information as a vertical list
 * ordered by date, overlaps and gaps flagged inline rather than drawn
 * (phases/05-income.md "Schedule timeline" — "Do not put a horizontally-
 * scrolling Gantt chart on a phone").
 *
 * @param {{ entries: ScheduleEntry[], variants: IncomeVariant[], onEditEntry: (entry: ScheduleEntry) => void }} props
 */
function ScheduleTimelineMobile({ entries, variants, onEditEntry }) {
  const overlapping = useMemo(() => computeOverlappingIds(entries), [entries]);
  const sorted = [...entries].sort((a, b) => a.startsOn.localeCompare(b.startsOn));

  return (
    <DataList>
      {sorted.map((entry, i) => {
        const prev = sorted[i - 1];
        const hasGapBefore = prev && prev.endsOn && entry.startsOn > prev.endsOn;
        return (
          <div key={entry.id}>
            {hasGapBefore ? (
              <div className="flex items-center gap-2 bg-warning-soft px-4 py-2 text-xs text-text">
                <AlertTriangleIcon className="size-3.5 shrink-0 text-warning-strong" aria-hidden="true" />
                Gap: no variant from {formatIsoDate(/** @type {string} */ (prev?.endsOn), "en-AU")} to{" "}
                {formatIsoDate(entry.startsOn, "en-AU")}
              </div>
            ) : null}
            <DataListRow
              onClick={() => onEditEntry(entry)}
              primary={
                <span className="flex items-center gap-2">
                  {variantName(variants, entry.variantId)}
                  {overlapping.has(entry.id) ? <Badge variant="attention">Overlaps</Badge> : null}
                </span>
              }
              secondary={`${formatIsoDate(entry.startsOn, "en-AU")} – ${entry.endsOn ? formatIsoDate(entry.endsOn, "en-AU") : "open-ended"}`}
            />
          </div>
        );
      })}
    </DataList>
  );
}

/**
 * Pick two variants, see the per-pay and per-month difference — informational
 * only, no button writes anything (phases/05-income.md "Variant comparison").
 *
 * @param {{ variants: IncomeVariant[], people: Person[], payCadenceLabel: string | null }} props
 */
function ComparisonPanel({ variants, people, payCadenceLabel }) {
  const [aId, setAId] = useState(variants[0]?.id ?? "");
  const [bId, setBId] = useState(variants[1]?.id ?? variants[0]?.id ?? "");

  const a = variants.find((v) => v.id === aId) ?? null;
  const b = variants.find((v) => v.id === bId) ?? null;

  const personIds = Array.from(
    new Set([...(a ? Object.keys(a.totals.perPersonCents) : []), ...(b ? Object.keys(b.totals.perPersonCents) : [])]),
  );

  return (
    <div className="flex flex-col gap-4 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) md:p-5">
      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Variant A" htmlFor="compare-a">
          <Select value={aId} onValueChange={setAId}>
            <SelectTrigger id="compare-a" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {variants.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
        <FieldRow label="Variant B" htmlFor="compare-b">
          <Select value={bId} onValueChange={setBId}>
            <SelectTrigger id="compare-b" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {variants.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
      </div>

      {a && b ? (
        <div className="flex flex-col gap-2">
          {personIds.map((personId) => {
            const aTotals = a.totals.perPersonCents[personId];
            const bTotals = b.totals.perPersonCents[personId];
            const diff = (aTotals?.perPay ?? aTotals?.perMonth ?? 0) - (bTotals?.perPay ?? bTotals?.perMonth ?? 0);
            return (
              <div key={personId} className="flex items-center justify-between text-sm">
                <span className="text-text">{personName(people, personId)}</span>
                <Delta value={diff} kind="cents" />
              </div>
            );
          })}
          <div className="flex items-center justify-between border-t border-border pt-2 text-sm font-semibold">
            <span className="text-text">
              Total {a.totals.totalCents.perPay != null ? `per pay (${payCadenceLabel})` : "per month"}
            </span>
            <Delta
              value={
                (a.totals.totalCents.perPay ?? a.totals.totalCents.perMonth) -
                (b.totals.totalCents.perPay ?? b.totals.totalCents.perMonth)
              }
              kind="cents"
            />
          </div>
        </div>
      ) : (
        <p className="text-sm text-text-muted">Choose two variants to compare.</p>
      )}
    </div>
  );
}

/**
 * Full card: lines, totals, duplicate/archive — the active variant gets a
 * tinted ring (phases/05-income.md "Variants"). The name, the notes and
 * every part of a line are edited where they sit; there is no edit dialog.
 *
 * @param {{
 *   variant: IncomeVariant,
 *   isActive: boolean,
 *   people: Person[],
 *   payCadenceLabel: string | null,
 *   duplicating: boolean,
 *   onUpdate: (patch: Partial<VariantFormData>) => Promise<unknown>,
 *   onDuplicate: () => void,
 *   onArchive: () => void,
 *   onAddLine: () => void,
 *   onUpdateLine: (id: string, patch: Partial<IncomeLineFormData>) => Promise<unknown>,
 *   onDeleteLine: (id: string) => void,
 * }} props `duplicating` disables Duplicate while a copy is being made — a
 *   double click used to make two.
 */
function VariantCard({ variant, isActive, people, payCadenceLabel, duplicating, onUpdate, onDuplicate, onArchive, onAddLine, onUpdateLine, onDeleteLine }) {
  const cadenceOptions = CADENCES.map((c) => ({ value: c, label: CADENCE_LABELS[c] }));
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-(--radius-card) bg-surface p-5 shadow-(--shadow-card)",
        isActive && "ring-2 ring-(--accent)",
      )}
    >
      <div className={cn(EDITABLE_GROUP, "flex items-start justify-between gap-2")}>
        <div className="flex min-w-0 flex-col items-start">
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <h3 className="min-w-0 font-semibold text-text">
              <InlineText value={variant.name} label="Variant name" required maxLength={160} onSave={(name) => onUpdate({ name: name ?? variant.name })} />
            </h3>
            {isActive ? <Badge variant="secondary">Active today</Badge> : null}
          </div>
          <InlineText
            value={variant.notes}
            label="Variant notes"
            placeholder="Add a note"
            multiline
            maxLength={2000}
            className="mt-1 text-xs text-text-muted"
            onSave={(notes) => onUpdate({ notes })}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Duplicate variant" onClick={onDuplicate} disabled={duplicating}>
            <CopyIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" className="text-text-muted hover:text-text" aria-label="Archive variant" onClick={onArchive}>
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <div className="flex flex-col divide-y divide-border text-sm">
        {variant.lines.map((line) => {
          // A line whose person has since gone keeps its own name in the
          // list, so the select still says who it was.
          const personOptions = people.map((p) => ({ value: p.id, label: p.name }));
          if (!people.some((p) => p.id === line.personId)) {
            personOptions.push({ value: line.personId, label: personName(people, line.personId) });
          }
          return (
            <div key={line.id} className={cn(EDITABLE_GROUP, "flex flex-col gap-1 py-2 first:pt-0 last:pb-0")}>
              <div className="flex min-w-0 items-baseline gap-1 text-text">
                <InlineSelect
                  value={line.personId}
                  options={personOptions}
                  label="Person"
                  onSave={(personId) => onUpdateLine(line.id, { personId })}
                />
                {line.label ? <span className="text-text-muted">·</span> : null}
                <InlineText
                  value={line.label}
                  label="Line label"
                  placeholder="Add a label"
                  maxLength={160}
                  className={cn("min-w-0 text-text-muted", !line.label && "ml-1")}
                  onSave={(label) => onUpdateLine(line.id, { label })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <InlineSelect
                  value={line.cadence}
                  options={cadenceOptions}
                  label="Cadence"
                  className="text-xs text-text-subtle"
                  onSave={(cadence) => onUpdateLine(line.id, { cadence })}
                />
                <div className="flex shrink-0 items-center gap-1">
                  <InlineMoney
                    value={line.amountCents}
                    label="Amount"
                    className="font-medium text-text"
                    onSave={(amountCents) => onUpdateLine(line.id, { amountCents })}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-text-muted hover:text-text"
                    aria-label="Delete line"
                    onClick={() => onDeleteLine(line.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
              {line.notes ? (
                <InlineText
                  value={line.notes}
                  label="Line notes"
                  multiline
                  maxLength={2000}
                  className="text-xs text-text-muted"
                  onSave={(notes) => onUpdateLine(line.id, { notes })}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <Button size="sm" variant="outline" className="self-start" onClick={onAddLine}>
        <PlusIcon />
        Add line
      </Button>

      <TotalsRow totals={variant.totals} payCadenceLabel={payCadenceLabel} />
    </div>
  );
}

/**
 * Mobile: variant summaries in a list, tapping opens this sheet with the
 * full card content (phases/05-income.md "Variants").
 *
 * @param {{
 *   variant: IncomeVariant | null,
 *   isActive: boolean,
 *   people: Person[],
 *   payCadenceLabel: string | null,
 *   duplicating: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   onUpdate: (patch: Partial<VariantFormData>) => Promise<unknown>,
 *   onDuplicate: () => void,
 *   onArchive: () => void,
 *   onAddLine: () => void,
 *   onUpdateLine: (id: string, patch: Partial<IncomeLineFormData>) => Promise<unknown>,
 *   onDeleteLine: (id: string) => void,
 * }} props
 */
function VariantDetailSheet(props) {
  const { variant, onOpenChange } = props;
  return (
    <Sheet open={variant !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" scrollable className="max-h-[85vh]">
        <SheetHeader>
          <SheetTitle>{variant?.name}</SheetTitle>
          <SheetDescription>{variant?.notes ?? "Lines and totals for this variant."}</SheetDescription>
        </SheetHeader>
        {variant ? (
          <div className="px-4 pb-6">
            <VariantCard {...props} variant={variant} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Named income scenarios, the calendar that resolves which one is active,
 * and a comparison tool — no allocation, no tax math, no leave-entitlement
 * tracking (phases/05-income.md "Non-goals").
 */
/** @typedef {{ id: string, personId: string, anchorDate: string, cadence: import("@budget/engine").Cadence, isPrimary: boolean }} PaySchedule */
/** @typedef {{ personId: string, anchorDate: string, cadence: import("@budget/engine").Cadence, isPrimary: boolean }} PayScheduleFormData */

/**
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   schedule: PaySchedule | null,
 *   hasPrimary: boolean,
 *   people: { id: string, name: string }[],
 *   submitting: boolean,
 *   onSubmit: (data: PayScheduleFormData) => Promise<void>,
 * }} props `hasPrimary` — whether any schedule is primary already.
 */
function PayScheduleFormDialog({ open, onOpenChange, schedule, hasPrimary, people, submitting, onSubmit }) {
  const { locale } = useSettings();
  const [personId, setPersonId] = useState("");
  const [anchorDate, setAnchorDate] = useState(todayIso());
  const [cadence, setCadence] = useState(/** @type {import("@budget/engine").Cadence} */ ("fortnightly"));
  const [isPrimary, setIsPrimary] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    setPersonId(schedule?.personId ?? people[0]?.id ?? "");
    setAnchorDate(schedule?.anchorDate ?? todayIso());
    setCadence(schedule?.cadence ?? "fortnightly");
    // A new schedule starts as Primary when none is: the first schedule a
    // household adds is the one its cycle runs on, and leaving the switch
    // off left every per-pay figure in the app blank with no clue why. Said
    // here rather than defaulted on the server, which can't tell "left
    // alone" from an explicit "not primary".
    setIsPrimary(schedule ? schedule.isPrimary : !hasPrimary);
    setError(null);
    // `hasPrimary` is read once per opening, not tracked: a refetch landing
    // while the form is open must not flip a switch the operator set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule, people]);

  // Computed entirely client-side — @budget/engine is pure and zero-I/O, so
  // there's no reason to round-trip to the API just to preview what the
  // operator hasn't saved yet (phases/04-accounts-people.md wants this
  // preview live "as the operator types").
  const preview = useMemo(() => {
    if (!anchorDate) return [];
    try {
      return projectPaydays({ anchorDate, cadence }, { from: anchorDate, to: addDaysIso(anchorDate, 3660) }).slice(
        0,
        6,
      );
    } catch {
      return [];
    }
  }, [anchorDate, cadence]);

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!schedule && !personId) {
      setError("Choose a person.");
      return;
    }
    // Always includes `personId`, even when editing — the PATCH schema
    // (zod/pay-schedules.js) has no such field, so Zod's default "strip
    // unknown keys" behaviour drops it there; one uniform shape here instead
    // of a create/update union.
    const data = { personId, anchorDate, cadence, isPrimary };
    try {
      await onSubmit(data);
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit pay schedule" : "Add pay schedule"}</DialogTitle>
          <DialogDescription>Any known payday — the rest of the series is derived from it.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!schedule && people.length === 0 ? <NoPeopleNotice what="Pay schedules" /> : null}
          {!schedule ? (
            <FieldRow label="Person" htmlFor="schedule-person">
              <Select value={personId} onValueChange={setPersonId}>
                <SelectTrigger id="schedule-person" className="w-full">
                  <SelectValue placeholder="Choose a person" />
                </SelectTrigger>
                <SelectContent>
                  {people.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          ) : null}
          <FieldRow label="Anchor date" htmlFor="schedule-anchor" hint="Any payday you know for certain.">
            <DatePicker id="schedule-anchor" value={anchorDate} onChange={setAnchorDate} />
          </FieldRow>
          <FieldRow label="Cadence" htmlFor="schedule-cadence">
            <Select value={cadence} onValueChange={(value) => setCadence(/** @type {import("@budget/engine").Cadence} */ (value))}>
              <SelectTrigger id="schedule-cadence" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow
            label="Primary schedule"
            htmlFor="schedule-primary"
            hint="The schedule that defines your household's transfer cycle. Only one may be set."
          >
            <Switch id="schedule-primary" checked={isPrimary} onCheckedChange={setIsPrimary} />
          </FieldRow>
          {preview.length > 0 ? (
            <FieldRow label="Next paydays">
              <div className="flex flex-wrap gap-1.5">
                {preview.map((d) => (
                  <Badge key={d} variant="outline">
                    {formatIsoDate(d, locale)}
                  </Badge>
                ))}
              </div>
            </FieldRow>
          ) : null}
          {error ? <InlineError>{error}</InlineError> : null}
          <DialogFooter>
            <Button type="submit" disabled={submitting || (!schedule && people.length === 0)}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who gets paid, how often, and which schedule defines the household's
 * transfer cycle. This was a tab on the old /settings page; it is income,
 * and it belongs beside the income it describes — every per-pay figure on
 * this screen is quoted in the cadence set here.
 *
 * `people` and `schedules` come from the page rather than from queries of
 * this panel's own: IncomePage already holds both, and a second `useQuery`
 * on the same keys would only be the same cache read written twice.
 *
 * @param {{
 *   people: Person[],
 *   peopleMissing: boolean,
 *   schedules: PaySchedule[],
 *   isLoading: boolean,
 *   error: Error | null,
 *   onRetry: () => unknown,
 * }} props `peopleMissing` — people have loaded and there are none, which
 *   is what disables adding a schedule.
 */
function PaySchedulesPanel({ people, peopleMissing, schedules, isLoading, error, onRetry }) {
  const confirm = useConfirm();
  const { locale } = useSettings();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(/** @type {PaySchedule | null} */ (null));
  const hasPrimary = schedules.some((s) => s.isPrimary);

  // Every "per pay" figure on this page — the variant cards' totals, the
  // banner — is quoted in the primary schedule's cadence, and comes back
  // from the server already converted. Refetching only the schedules left
  // them all on the old cadence until something else happened to reload.
  function invalidateSchedules() {
    queryClient.invalidateQueries({ queryKey: ["pay-schedules"] });
    queryClient.invalidateQueries({ queryKey: ["income-variants"] });
    queryClient.invalidateQueries({ queryKey: ["income-resolve"] });
  }

  const createMutation = useMutation({
    mutationFn: async (/** @type {PayScheduleFormData} */ data) => {
      const res = await api["pay-schedules"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateSchedules();
      toast.success("Pay schedule added.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (/** @type {{ id: string, data: PayScheduleFormData }} */ { id, data }) => {
      const res = await api["pay-schedules"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateSchedules();
      toast.success("Pay schedule updated.");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["pay-schedules"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateSchedules();
      toast.success("Pay schedule archived.");
    },
    onError: (err) => toast.error(err.message),
  });

  useEffect(
    () =>
      registerCommands([
        {
          id: "pay-schedules:add",
          group: "Actions",
          label: "Add pay schedule",
          icon: CalendarClockIcon,
          run: () => {
            setEditing(null);
            setFormOpen(true);
          },
        },
      ]),
    [],
  );

  /** @param {string} personId */
  function personName(personId) {
    return people.find((p) => p.id === personId)?.name ?? "Unknown person";
  }

  /** @param {{ anchorDate: string, cadence: import("@budget/engine").Cadence }} schedule */
  function nextPayday(schedule) {
    try {
      const from = todayIso();
      const [next] = projectPaydays(schedule, { from, to: addDaysIso(from, 400) });
      return next ?? null;
    } catch {
      return null;
    }
  }

  return (
    <>
      {/* The section's own control sits on its heading row rather than in
          the page control bar above: that bar already carries two buttons
          and a third overflows it at 375px. */}
      <PageSection
        id="pay-schedules"
        title="Pay schedules"
        description={
          <>
            One known payday per person. Everything on this page quoted &ldquo;per pay&rdquo; uses the primary
            schedule&apos;s cadence.
          </>
        }
        actions={
          <Button
            variant="outline"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            disabled={people.length === 0}
          >
            <PlusIcon />
            Add pay schedule
          </Button>
        }
      >
        {/* The reason the buttons are disabled, said where it can be read.
            It used to live in a `title` tooltip, which a phone never shows —
            so on first run the screen offered two dead buttons and no way
            forward. */}
        {peopleMissing ? <NoPeopleNotice what="Pay schedules" /> : null}
        {isLoading ? (
          <ListSkeleton rows={2} label="Loading pay schedules" />
        ) : error ? (
          <QueryError error={error} what="your pay schedules" onRetry={onRetry} />
        ) : schedules.length === 0 ? (
          <EmptyState
            icon={CalendarClockIcon}
            title="No pay schedules yet"
            description="Add one known payday per person — the rest of the series, including any 27-payday years, is derived from it."
            action={
              <Button
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
                disabled={people.length === 0}
              >
                <PlusIcon />
                Add pay schedule
              </Button>
            }
          />
        ) : (
          // Its own rows rather than <DataListRow>: that truncates its second
          // line, and beside Edit and Archive on a phone it cut every schedule
          // off at "anchored 16 Sept…" — before the next payday, the one date
          // anybody opens this for.
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-(--radius-card) bg-surface shadow-(--shadow-card)">
            {schedules.map((schedule) => {
              const next = nextPayday(schedule);
              return (
                <li key={schedule.id} className="flex items-center justify-between gap-3 py-2.5 pr-2 pl-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-text">
                      <span className="truncate">{personName(schedule.personId)}</span>
                      {schedule.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
                    </p>
                    <p className="text-xs text-text-muted">
                      {CADENCE_LABELS[schedule.cadence]}
                      {next ? ` · next ${formatIsoDate(next, locale)}` : ""}
                      <span className="text-text-subtle"> · anchored {formatIsoDate(schedule.anchorDate, locale)}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(schedule);
                        setFormOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-text-muted hover:text-text"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Archive ${personName(schedule.personId)}'s pay schedule?`,
                          description: schedule.isPrimary
                            ? "This is the primary schedule — archiving it leaves every per-pay figure in the app without a cadence until another is made primary."
                            : "It stops being selectable. Anything already resolved against it is kept.",
                          confirmLabel: "Archive",
                        });
                        if (ok) archiveMutation.mutate(schedule.id);
                      }}
                    >
                      Archive
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </PageSection>

      <PayScheduleFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        schedule={editing}
        hasPrimary={hasPrimary}
        people={people}
        submitting={createMutation.isPending || updateMutation.isPending}
        onSubmit={async (data) => {
          if (editing) {
            await updateMutation.mutateAsync({ id: editing.id, data });
          } else {
            await createMutation.mutateAsync(data);
          }
        }}
      />
    </>
  );
}

export function IncomePage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const search = useSearch({ strict: false });
  const queryClient = useQueryClient();

  const [variantFormOpen, setVariantFormOpen] = useState(false);
  // The id, not the variant: the phone's detail sheet is where lines are
  // added, edited and deleted, and a stored copy of the variant never saw
  // any of it — the sheet kept showing the lines as they were when it
  // opened, which invited adding the "missing" line a second time.
  const [detailVariantId, setDetailVariantId] = useState(/** @type {string | null} */ (null));
  // The variant a line is being added to; editing one happens on its card.
  const [lineFormVariantId, setLineFormVariantId] = useState(/** @type {string | null} */ (null));
  const [scheduleForm, setScheduleForm] = useState(
    /** @type {{ entry: ScheduleEntry | null } | null} */ (null),
  );

  const variantsQuery = useQuery(incomeVariantsQueryOptions());

  const peopleQuery = useQuery(peopleQueryOptions());

  const scheduleQuery = useQuery(variantScheduleQueryOptions());

  const resolveQuery = useQuery(incomeResolveQueryOptions(todayIso()));

  const payScheduleQuery = useQuery(paySchedulesQueryOptions());

  const variants = variantsQuery.data?.variants ?? [];
  // Looked up afresh each render, so the sheet shows the variant as it is
  // now. An archived variant drops out of `variants`, which closes it.
  const detailVariant = detailVariantId ? (variants.find((v) => v.id === detailVariantId) ?? null) : null;
  const people = peopleQuery.data ?? [];
  const peopleMissing = peopleQuery.isSuccess && people.length === 0;
  const schedule = scheduleQuery.data ?? [];
  const paySchedules = payScheduleQuery.data ?? [];
  const primarySchedule = paySchedules.find((s) => s.isPrimary) ?? null;
  const payCadenceLabel = primarySchedule ? CADENCE_LABELS[primarySchedule.cadence] : null;
  const overrideVariant = search.variant ? (variants.find((v) => v.id === search.variant) ?? null) : null;

  // Returned, not just fired: a mutation whose `onSuccess` hands back this
  // promise doesn't settle until the fresh data is in, which is what lets an
  // inline field hold the typed value until the card can show the saved one.
  function invalidateIncome() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ["income-variants"] }),
      queryClient.invalidateQueries({ queryKey: ["income-resolve"] }),
    ]);
  }

  const createVariant = useMutation({
    mutationFn: async (/** @type {VariantFormData} */ data) => {
      const res = await api["income-variants"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateIncome();
      toast.success("Income variant added.");
    },
  });

  // One field at a time, from the card. No toast: the field itself shows the
  // change, and a toast per keystroke-and-Enter would be noise.
  const updateVariant = useMutation({
    mutationFn: async (/** @type {{ id: string, data: Partial<VariantFormData> }} */ { id, data }) => {
      const res = await api["income-variants"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateIncome,
  });

  const duplicateVariant = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["income-variants"][":id"].duplicate.$post({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateIncome();
      toast.success("Variant duplicated.");
    },
    onError: (err) => toast.error(err.message),
  });

  const archiveVariant = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["income-variants"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: () => {
      invalidateIncome();
      toast.success("Income variant archived.");
    },
    onError: (err) => toast.error(err.message),
  });

  const createLine = useMutation({
    mutationFn: async (/** @type {IncomeLineFormData & { variantId: string }} */ data) => {
      const res = await api["income-lines"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateIncome,
  });

  const updateLine = useMutation({
    mutationFn: async (/** @type {{ id: string, data: Partial<IncomeLineFormData> }} */ { id, data }) => {
      const res = await api["income-lines"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateIncome,
  });

  const deleteLine = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["income-lines"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateIncome,
    onError: (err) => toast.error(err.message),
  });

  function invalidateSchedule() {
    queryClient.invalidateQueries({ queryKey: ["variant-schedule"] });
    queryClient.invalidateQueries({ queryKey: ["income-resolve"] });
  }

  const createSchedule = useMutation({
    mutationFn: async (/** @type {ScheduleFormData} */ data) => {
      const res = await api["variant-schedule"].$post({ json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateSchedule,
  });

  const updateSchedule = useMutation({
    mutationFn: async (/** @type {{ id: string, data: ScheduleFormData }} */ { id, data }) => {
      const res = await api["variant-schedule"][":id"].$patch({ param: { id }, json: data });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateSchedule,
  });

  const deleteSchedule = useMutation({
    mutationFn: async (/** @type {string} */ id) => {
      const res = await api["variant-schedule"][":id"].$delete({ param: { id } });
      if (!res.ok) throw new Error(await readApiError(res));
      return res.json();
    },
    onSuccess: invalidateSchedule,
    onError: (err) => toast.error(err.message),
  });

  // Both are reached from two places each — the card grid and the detail
  // sheet — so the wording of the confirmation lives in one place rather
  // than being retyped per call site and drifting.
  /** @param {{ id: string, name: string }} variant */
  async function confirmArchiveVariant(variant) {
    const ok = await confirm({
      title: `Archive "${variant.name}"?`,
      description: "It stops being selectable and stops resolving from the schedule. Its lines are kept.",
      confirmLabel: "Archive",
    });
    if (ok) archiveVariant.mutate(variant.id);
    return ok;
  }

  /** @param {string} id */
  async function confirmDeleteLine(id) {
    const ok = await confirm({
      title: "Delete this income line?",
      description: "Gross income for this variant drops by its amount, and every allocation resolved from it moves.",
      confirmLabel: "Delete",
    });
    if (ok) deleteLine.mutate(id);
  }

  useEffect(
    () =>
      registerCommands([
        {
          id: "income:add-variant",
          group: "Actions",
          label: "Add income variant",
          icon: PlusIcon,
          run: () => setVariantFormOpen(true),
        },
        {
          id: "income:edit-schedule",
          group: "Actions",
          label: "Edit schedule",
          icon: CalendarRangeIcon,
          run: () => setScheduleForm({ entry: null }),
        },
        {
          id: "income:compare-variants",
          group: "Actions",
          label: "Compare variants",
          icon: GitCompareIcon,
          run: () => document.getElementById("income-comparison")?.scrollIntoView({ behavior: "smooth" }),
        },
      ]),
    [],
  );

  const isLoading = variantsQuery.isLoading || peopleQuery.isLoading;

  // Arriving at /income#pay-schedules — from the dashboard's setup list or
  // the variable-costs empty state — should land on that section. The router
  // scrolls to the hash as the page first renders, but everything above it
  // is a skeleton then and grows as it loads, pushing the section back off
  // screen; so scroll again once the page has settled.
  const hash = useLocation({ select: (location) => location.hash });
  const settled =
    !isLoading && !scheduleQuery.isLoading && !payScheduleQuery.isLoading && !resolveQuery.isLoading;
  useEffect(() => {
    if (settled && hash === "pay-schedules") document.getElementById("pay-schedules")?.scrollIntoView({ block: "start" });
  }, [settled, hash]);

  return (
    <>
      <PageHeader
        title="Income"
        description="Named income scenarios and the calendar that says which one is active."
        // One control bar at the top carrying every action on this screen,
        // rather than an "Add entry" button buried beside the Schedule
        // heading halfway down.
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setScheduleForm({ entry: null })}
              disabled={variants.length === 0}
            >
              <PlusIcon />
              Add schedule entry
            </Button>
            <Button onClick={() => setVariantFormOpen(true)}>
              <PlusIcon />
              Add variant
            </Button>
          </>
        }
      />

      {resolveQuery.error ? (
        <QueryError error={resolveQuery.error} what="today's income" onRetry={() => resolveQuery.refetch()} />
      ) : (
        <ActiveVariantBanner
          resolution={resolveQuery.data}
          isLoading={resolveQuery.isLoading}
          variants={variants}
          payCadenceLabel={payCadenceLabel}
          override={overrideVariant}
          onClearOverride={() =>
            navigate({
              to: "/income",
              search: (/** @type {{ variant?: string }} */ prev) => ({ ...prev, variant: undefined }),
            })
          }
        />
      )}

      {!payCadenceLabel && payScheduleQuery.isSuccess ? (
        <div className="rounded-(--radius-card) bg-surface-muted p-3 text-sm text-text-muted">
          No primary pay schedule is set, so per-pay figures aren&apos;t available yet — only per-month and per-year.{" "}
          <Button
            variant="link"
            className="h-auto p-0"
            onClick={() => document.getElementById("pay-schedules")?.scrollIntoView({ behavior: "smooth" })}
          >
            Set one below
          </Button>
          .
        </div>
      ) : null}

      {/* Sits above variants: which variant is live on a given date is the
          more pertinent question, and the variants below are what it selects
          between. Named "Variant schedule" rather than plain "Schedule"
          because pay schedules are on this page too, and they are a
          different calendar entirely. */}
      <PageSection title="Variant schedule">
        {scheduleQuery.isLoading ? (
          <PanelSkeleton height={140} label="Loading variant schedule" />
        ) : scheduleQuery.error ? (
          <QueryError error={scheduleQuery.error} what="the variant schedule" onRetry={() => scheduleQuery.refetch()} />
        ) : schedule.length === 0 ? (
          <EmptyState
            icon={CalendarRangeIcon}
            title="No schedule yet"
            description="Add an entry so the app knows which variant is active on any given date. Until then, every date is a gap."
          />
        ) : (
          <>
            <div className="hidden md:block">
              <ScheduleTimelineDesktop
                entries={schedule}
                variants={variants}
                onEditEntry={(entry) => setScheduleForm({ entry })}
              />
            </div>
            <div className="md:hidden">
              <ScheduleTimelineMobile
                entries={schedule}
                variants={variants}
                onEditEntry={(entry) => setScheduleForm({ entry })}
              />
            </div>
          </>
        )}
      </PageSection>

      <PageSection title="Variants">
        {isLoading ? (
          <CardsSkeleton cards={3} height={300} label="Loading income variants" />
        ) : variantsQuery.error || peopleQuery.error ? (
          <QueryError
            error={variantsQuery.error ?? peopleQuery.error}
            what="your income variants"
            onRetry={() => Promise.all([variantsQuery.refetch(), peopleQuery.refetch()])}
          />
        ) : variants.length === 0 ? (
          <EmptyState
            icon={WalletIcon}
            title="No income variants yet"
            description="Add each income scenario the household goes through — Usual, and any parental-leave phases — starting with Usual."
            action={
              <Button onClick={() => setVariantFormOpen(true)}>
                <PlusIcon />
                Add income variant
              </Button>
            }
          />
        ) : (
          <>
            <div className="hidden gap-4 md:grid md:grid-cols-2 md:gap-6 xl:grid-cols-3">
              {variants.map((variant) => (
                <VariantCard
                  key={variant.id}
                  variant={variant}
                  isActive={resolveQuery.data?.variantId === variant.id}
                  people={people}
                  payCadenceLabel={payCadenceLabel}
                  onUpdate={(data) => updateVariant.mutateAsync({ id: variant.id, data })}
                  duplicating={duplicateVariant.isPending}
                  onDuplicate={() => duplicateVariant.mutate(variant.id)}
                  onArchive={() => confirmArchiveVariant(variant)}
                  onAddLine={() => setLineFormVariantId(variant.id)}
                  onUpdateLine={(id, data) => updateLine.mutateAsync({ id, data })}
                  onDeleteLine={confirmDeleteLine}
                />
              ))}
            </div>

            <DataList className="md:hidden">
              {variants.map((variant) => (
                <DataListRow
                  key={variant.id}
                  onClick={() => setDetailVariantId(variant.id)}
                  primary={
                    <span className="flex items-center gap-2">
                      {variant.name}
                      {resolveQuery.data?.variantId === variant.id ? <Badge variant="secondary">Active</Badge> : null}
                    </span>
                  }
                  secondary={`${variant.lines.length} line${variant.lines.length === 1 ? "" : "s"}`}
                  trailing={
                    variant.totals.totalCents.perPay != null ? (
                      <Money value={variant.totals.totalCents.perPay} />
                    ) : (
                      <Money value={variant.totals.totalCents.perMonth} />
                    )
                  }
                />
              ))}
            </DataList>
          </>
        )}
      </PageSection>

      {variants.length >= 2 ? (
        <PageSection id="income-comparison" title="Compare variants">
          <ComparisonPanel variants={variants} people={people} payCadenceLabel={payCadenceLabel} />
        </PageSection>
      ) : null}

      {/* Last on the page on purpose: set-once configuration, below the
          day-to-day reading order (active today → variant schedule →
          variants) that adjustment #13 settled. */}
      <PaySchedulesPanel
        people={people}
        peopleMissing={peopleMissing}
        schedules={paySchedules}
        isLoading={payScheduleQuery.isLoading}
        error={payScheduleQuery.error}
        onRetry={() => payScheduleQuery.refetch()}
      />

      <VariantFormDialog
        open={variantFormOpen}
        onOpenChange={setVariantFormOpen}
        submitting={createVariant.isPending}
        onSubmit={async (data) => {
          await createVariant.mutateAsync(data);
        }}
      />

      <IncomeLineFormDialog
        open={lineFormVariantId !== null}
        onOpenChange={(open) => !open && setLineFormVariantId(null)}
        people={people}
        submitting={createLine.isPending}
        onSubmit={async (data) => {
          if (lineFormVariantId) await createLine.mutateAsync({ variantId: lineFormVariantId, ...data });
        }}
      />

      <ScheduleEntryFormDialog
        open={scheduleForm !== null}
        onOpenChange={(open) => !open && setScheduleForm(null)}
        entry={scheduleForm?.entry ?? null}
        variants={variants}
        submitting={createSchedule.isPending || updateSchedule.isPending}
        onSubmit={async (data) => {
          if (scheduleForm?.entry) {
            await updateSchedule.mutateAsync({ id: scheduleForm.entry.id, data });
          } else {
            await createSchedule.mutateAsync(data);
          }
        }}
        onDelete={
          scheduleForm?.entry
            ? () => {
                const entry = scheduleForm.entry;
                if (!entry) return;
                confirm({
                  title: "Delete this schedule entry?",
                  description:
                    "The window it covers stops resolving to its variant — dates inside it fall through to whatever else covers them, or to nothing.",
                  confirmLabel: "Delete",
                }).then((ok) => {
                  if (!ok) return;
                  deleteSchedule.mutate(entry.id);
                  setScheduleForm(null);
                });
              }
            : null
        }
      />

      <VariantDetailSheet
        variant={detailVariant}
        isActive={detailVariant !== null && resolveQuery.data?.variantId === detailVariant.id}
        people={people}
        payCadenceLabel={payCadenceLabel}
        onOpenChange={(open) => !open && setDetailVariantId(null)}
        onUpdate={async (data) => {
          if (detailVariant) await updateVariant.mutateAsync({ id: detailVariant.id, data });
        }}
        duplicating={duplicateVariant.isPending}
        onDuplicate={() => detailVariant && duplicateVariant.mutate(detailVariant.id)}
        onArchive={async () => {
          if (!detailVariant) return;
          if (!(await confirmArchiveVariant(detailVariant))) return;
          setDetailVariantId(null);
        }}
        onAddLine={() => detailVariant && setLineFormVariantId(detailVariant.id)}
        onUpdateLine={(id, data) => updateLine.mutateAsync({ id, data })}
        onDeleteLine={confirmDeleteLine}
      />
    </>
  );
}
