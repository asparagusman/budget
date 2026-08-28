import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FileSpreadsheetIcon,
  InfoIcon,
  UploadIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Input } from "@/components/ui/input.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { EmptyState } from "@/components/empty-state.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { Money } from "@/components/money.jsx";
import { PageHeader } from "@/components/page-header.jsx";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, CADENCE_LABELS } from "@/lib/constants.js";
import { commitImport, fetchImportPreview } from "@/lib/import-api.js";
import { cn } from "@/lib/utils.js";

/** @import { Cents } from "@budget/engine" */
/** @import { DestinationChoice, ImportPreview, ImportPreviewResponse, ImportResult } from "@/lib/import-api.js" */

const CREATE_NEW = "__create__";

/**
 * A section of the preview. Every one of them is a plain stacked list rather
 * than a table — this screen is read on a phone as often as a laptop, and a
 * table that scrolls sideways is a failure (phases/README.md, "Every screen").
 *
 * @param {{
 *   title: string,
 *   description?: import("react").ReactNode,
 *   aside?: import("react").ReactNode,
 *   children: import("react").ReactNode,
 * }} props
 */
function Section({ title, description, aside, children }) {
  return (
    <section className="flex flex-col gap-3 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-card) sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-text-muted">{description}</p> : null}
        </div>
        {aside ? <div className="shrink-0 text-xs text-text-muted">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * One deselectable row. The whole row is the label, so the tap target is the
 * row and not a 16px box — "every row is individually deselectable" is only
 * true if the operator can actually hit it.
 *
 * @param {{
 *   checked: boolean,
 *   onChange: (checked: boolean) => void,
 *   primary: import("react").ReactNode,
 *   secondary?: import("react").ReactNode,
 *   trailing?: import("react").ReactNode,
 *   flagged?: boolean,
 * }} props
 */
function SelectableRow({ checked, onChange, primary, secondary, trailing, flagged = false }) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-(--radius-control) px-2 py-2 transition-colors hover:bg-surface-muted has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--accent)",
        flagged && "bg-warning-soft hover:bg-warning-soft",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 shrink-0 accent-(--accent)"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text">{primary}</span>
        {secondary ? <span className="block truncate text-xs text-text-muted">{secondary}</span> : null}
      </span>
      {trailing ? <span className="shrink-0 text-right text-sm text-text tabular-nums">{trailing}</span> : null}
    </label>
  );
}

/**
 * A defect in the source workbook, stated with its explanation. Warnings are
 * things the operator has to decide; info is things they should know happened.
 *
 * @param {{ flag: ImportPreview["flags"][number] }} props
 */
function Flag({ flag }) {
  const warning = flag.severity === "warning";
  const Icon = warning ? AlertTriangleIcon : InfoIcon;
  return (
    <li
      className={cn(
        "flex gap-2.5 rounded-(--radius-control) p-3 text-sm",
        warning ? "bg-warning-soft text-text" : "bg-surface-muted text-text",
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", warning ? "text-warning" : "text-text-subtle")}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="font-medium">
          {warning ? <span className="sr-only">Warning: </span> : <span className="sr-only">Note: </span>}
          {flag.title}
        </p>
        <p className="mt-0.5 text-xs text-text-muted">{flag.detail}</p>
      </div>
    </li>
  );
}

/**
 * The mapping step. Every free-text destination in the spreadsheet has to
 * become a real account before anything is written, and the only way to get
 * a new account is to ask for one here by name
 * (phases/11-polish-mobile-import.md, workstream C, item 4).
 *
 * @param {{
 *   preview: ImportPreview,
 *   accounts: ImportPreviewResponse["accounts"],
 *   choices: Record<string, DestinationChoice>,
 *   onChange: (key: string, choice: DestinationChoice | null) => void,
 * }} props
 */
function DestinationMapping({ preview, accounts, choices, onChange }) {
  const unmapped = preview.destinations.filter((d) => !choices[d.key]).length;

  return (
    <Section
      title="Transfer destinations"
      description="The spreadsheet names these as free text. Each one needs an account before anything is imported."
      aside={
        unmapped === 0 ? (
          <span className="flex items-center gap-1 text-positive">
            <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
            all mapped
          </span>
        ) : (
          `${unmapped} still to map`
        )
      }
    >
      <ul className="flex flex-col gap-3">
        {preview.destinations.map((destination) => {
          const choice = choices[destination.key];
          const value = choice && "accountId" in choice ? choice.accountId : choice ? CREATE_NEW : "";
          const creating = choice !== undefined && "create" in choice;
          const suggestion = destination.suggestions[0];

          return (
            <li key={destination.key} className="flex flex-col gap-2 border-b border-border pb-3 last:border-b-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{destination.raw}</p>
                <p className="truncate text-xs text-text-subtle">Used by {destination.usedBy.join(", ")}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  value={value}
                  onValueChange={(next) => {
                    if (next === CREATE_NEW) {
                      onChange(destination.key, {
                        create: { name: destination.raw.replace(/^to\s+/i, "").trim(), type: "savings" },
                      });
                    } else {
                      onChange(destination.key, { accountId: next });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-64" aria-label={`Account for ${destination.raw}`}>
                    <SelectValue placeholder="Choose an account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.name}
                        {suggestion?.accountId === account.id ? " · suggested" : ""}
                      </SelectItem>
                    ))}
                    <SelectItem value={CREATE_NEW}>Create a new account…</SelectItem>
                  </SelectContent>
                </Select>

                {creating && "create" in choice ? (
                  <div className="flex flex-1 flex-col gap-2 sm:flex-row">
                    <Input
                      aria-label={`New account name for ${destination.raw}`}
                      value={choice.create.name}
                      placeholder="Account name"
                      onChange={(e) =>
                        onChange(destination.key, { create: { ...choice.create, name: e.target.value } })
                      }
                    />
                    <Select
                      value={choice.create.type}
                      onValueChange={(type) =>
                        onChange(destination.key, {
                          create: {
                            ...choice.create,
                            type: /** @type {(typeof ACCOUNT_TYPES)[number]} */ (type),
                          },
                        })
                      }
                    >
                      <SelectTrigger className="w-full sm:w-40" aria-label={`New account type for ${destination.raw}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ACCOUNT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {ACCOUNT_TYPE_LABELS[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * The reconciliation summary. Every figure the spreadsheet held, beside what
 * the app now computes. A mismatch is shown rather than hidden — some of them
 * are expected, and the ones that are not are exactly what this is for
 * (phases/11-polish-mobile-import.md, "Post-import verification").
 *
 * @param {{ result: ImportResult, accounts: ImportPreviewResponse["accounts"], createdNames: string[] }} props
 */
function Reconciliation({ result, accounts }) {
  const { reconciliation: r } = result;
  const nameOf = (/** @type {string} */ id) => accounts.find((a) => a.id === id)?.name ?? "New account";

  /** @param {{ label: string, spreadsheet: Cents | null, imported: Cents, note?: string }} row */
  function CompareRow({ label, spreadsheet, imported, note }) {
    const matches = spreadsheet !== null && spreadsheet === imported;
    return (
      <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border py-2 last:border-b-0">
        <span className="text-sm text-text">{label}</span>
        <span className="flex items-baseline gap-3 text-sm tabular-nums">
          <span className="text-text-subtle">
            {spreadsheet === null ? "—" : <Money value={spreadsheet} />}
          </span>
          <span aria-hidden="true" className="text-text-subtle">
            →
          </span>
          <span className={cn("font-medium", matches ? "text-positive" : "text-text")}>
            <Money value={imported} />
          </span>
          {matches ? (
            <CheckCircle2Icon className="size-4 text-positive" aria-label="matches the spreadsheet" />
          ) : (
            <span className="text-xs text-text-muted">differs</span>
          )}
        </span>
        {note ? <p className="w-full text-xs text-text-muted">{note}</p> : null}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Fixed costs"
        description="Spreadsheet figure on the left, what the app now holds on the right."
      >
        <ul className="flex flex-col">
          <CompareRow
            label={`${r.fixedCosts.billCount} bills, per year`}
            spreadsheet={r.fixedCosts.spreadsheetPerYearCents}
            imported={r.fixedCosts.importedPerYearCents}
          />
        </ul>
        {r.fixedCosts.notes.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-xs text-text-muted">
            {r.fixedCosts.notes.map((note) => (
              <li key={note} className="flex gap-2">
                <span aria-hidden="true">·</span>
                <span>{note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Variable costs, per month">
        <ul className="flex flex-col">
          <CompareRow
            label="Essentials"
            spreadsheet={r.variableEssentials.spreadsheetPerMonthCents}
            imported={r.variableEssentials.importedPerMonthCents}
          />
          <CompareRow
            label="Non-essentials"
            spreadsheet={r.variableNonEssential.spreadsheetPerMonthCents}
            imported={r.variableNonEssential.importedPerMonthCents}
          />
        </ul>
      </Section>

      <Section title={`Income, per ${CADENCE_LABELS[result.payCadence].toLowerCase()}`}>
        <ul className="flex flex-col">
          {r.variants.map((variant) => (
            <CompareRow
              key={variant.name}
              label={variant.name}
              spreadsheet={variant.spreadsheetPerPayCents}
              imported={variant.importedPerPayCents}
            />
          ))}
        </ul>
      </Section>

      {r.plans.map((plan) => (
        <Section
          key={plan.name}
          title={`${plan.name} — transfers`}
          description={plan.variantName ? `Divides ${plan.variantName}.` : undefined}
          aside={
            plan.reconciles ? (
              <span className="flex items-center gap-1 text-positive">
                <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
                reconciles to income
              </span>
            ) : (
              <span className="flex items-center gap-1 text-negative">
                <AlertTriangleIcon className="size-3.5" aria-hidden="true" />
                does not reconcile
              </span>
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium tracking-wide text-text-subtle uppercase">Spreadsheet</p>
              <ul className="flex flex-col text-sm">
                {plan.spreadsheetTransfers.map((transfer) => (
                  <li key={transfer.label} className="flex justify-between gap-3 py-1">
                    <span className="truncate text-text-muted">{transfer.label}</span>
                    <span className="shrink-0 tabular-nums text-text-muted">
                      <Money value={transfer.amountCents} />
                    </span>
                  </li>
                ))}
                <li className="mt-1 flex justify-between gap-3 border-t border-border pt-1 font-medium">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {plan.spreadsheetTransferTotalCents === null ? (
                      "—"
                    ) : (
                      <Money value={plan.spreadsheetTransferTotalCents} />
                    )}
                  </span>
                </li>
              </ul>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium tracking-wide text-text-subtle uppercase">Imported</p>
              <ul className="flex flex-col text-sm">
                {plan.importedTransfers.map((transfer) => (
                  <li key={transfer.accountId} className="flex justify-between gap-3 py-1">
                    <span className="truncate text-text">
                      {nameOf(transfer.accountId)}
                      {transfer.isNoOp ? <span className="text-text-subtle"> · no move</span> : null}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <Money value={transfer.perPayCents} />
                    </span>
                  </li>
                ))}
                <li className="mt-1 flex justify-between gap-3 border-t border-border pt-1 font-medium">
                  <span>Total</span>
                  <span className="tabular-nums">
                    <Money value={plan.importedTotalPerPayCents} />
                  </span>
                </li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-text-muted">
            Gross is <Money value={plan.grossPerPayCents} /> and transfers total{" "}
            <Money value={plan.importedTotalPerPayCents} />.{" "}
            {plan.reconciles
              ? "They match exactly, which is the invariant the engine guarantees."
              : "They do not match — that is a bug, please report it."}
          </p>
        </Section>
      ))}
    </div>
  );
}

/**
 * The one-time migration path off the spreadsheet: upload, read the whole
 * preview, deselect anything wrong, map every destination, then import. It is
 * additive and idempotent — re-importing the same file updates rather than
 * duplicating — so re-running it after fixing a mapping is safe.
 */
export function ImportPage() {
  const queryClient = useQueryClient();
  const fileInput = useRef(/** @type {HTMLInputElement | null} */ (null));

  const [file, setFile] = useState(/** @type {File | null} */ (null));
  const [response, setResponse] = useState(/** @type {ImportPreviewResponse | null} */ (null));
  const [selected, setSelected] = useState(/** @type {Set<string>} */ (new Set()));
  const [destinations, setDestinations] = useState(/** @type {Record<string, DestinationChoice>} */ ({}));
  const [planVariants, setPlanVariants] = useState(/** @type {Record<string, string>} */ ({}));
  const [anchorDate, setAnchorDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [result, setResult] = useState(/** @type {ImportResult | null} */ (null));

  const preview = response?.preview ?? null;

  /** @param {File} next */
  async function loadPreview(next) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await fetchImportPreview(next);
      setFile(next);
      setResponse(data);
      setAnchorDate(data.defaultAnchorDate);
      // Everything is selected except the rows a flag says to leave off —
      // the phantom rent row is the reason that distinction exists.
      const initial = new Set([
        ...data.preview.variants.flatMap((v) => v.lines.map((l) => l.key)),
        ...data.preview.bills.filter((b) => b.defaultSelected).map((b) => b.key),
        ...data.preview.variableCategories.map((c) => c.key),
        ...data.preview.plans.flatMap((p) => p.lines.map((l) => l.key)),
        ...data.preview.balances.map((b) => b.key),
      ]);
      setSelected(initial);
      // A plan whose sheet unambiguously names its variant is pre-answered;
      // the ambiguous ones stay blank on purpose.
      /** @type {Record<string, string>} */
      const variants = {};
      for (const plan of data.preview.plans) {
        if (plan.variantKey && !plan.variantAmbiguous) variants[plan.key] = plan.variantKey;
      }
      setPlanVariants(variants);
      setDestinations({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file.");
      setResponse(null);
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  /** @param {string} key */
  function toggle(key) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /** @param {string[]} keys @param {boolean} on */
  function toggleMany(keys, on) {
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  const unmappedCount = useMemo(() => {
    if (!preview) return 0;
    /** @type {Set<string>} */
    const needed = new Set();
    for (const plan of preview.plans) {
      for (const line of plan.lines) {
        if (selected.has(line.key) && line.destinationKey) needed.add(line.destinationKey);
      }
    }
    for (const balance of preview.balances) {
      if (selected.has(balance.key)) needed.add(balance.destinationKey);
    }
    return [...needed].filter((key) => !destinations[key]).length;
  }, [preview, selected, destinations]);

  const missingVariants = useMemo(() => {
    if (!preview) return [];
    return preview.plans.filter(
      (plan) => plan.lines.some((line) => selected.has(line.key)) && !planVariants[plan.key],
    );
  }, [preview, selected, planVariants]);

  const canImport =
    preview !== null && !busy && unmappedCount === 0 && missingVariants.length === 0 && selected.size > 0;

  async function runImport() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const data = await commitImport(file, {
        anchorDate,
        selected: [...selected],
        destinations,
        planVariants,
      });
      setResult(data);
      // Everything on every other screen just changed.
      await queryClient.invalidateQueries();
      toast.success("Import complete.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The import failed.");
    } finally {
      setBusy(false);
    }
  }

  if (result && response) {
    return (
      <>
        <PageHeader
          title="Import complete"
          description="What the spreadsheet said, beside what the app now holds. Anything that differs is shown, not hidden."
          actions={
            <Button variant="outline" onClick={() => { setResult(null); setResponse(null); setFile(null); }}>
              Import another file
            </Button>
          }
        />

        <Section title="What landed">
          <ul className="flex flex-wrap gap-2 text-xs">
            {Object.entries(result.counts).map(([label, count]) => (
              <li key={label}>
                <Badge variant="secondary">
                  {count} {label.replace(/([A-Z])/g, " $1").toLowerCase()}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>

        {result.nextSteps.length > 0 ? (
          <Section title="Still to do" description="Decisions the app will not make for you.">
            <ul className="flex flex-col gap-2 text-sm text-text">
              {result.nextSteps.map((step) => (
                <li key={step} className="flex gap-2">
                  <span aria-hidden="true" className="text-text-subtle">
                    ·
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to="/allocation">Open allocation</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to="/accounts">Open accounts</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to="/costs/fixed">Open fixed costs</Link>
              </Button>
            </div>
          </Section>
        ) : null}

        <Reconciliation result={result} accounts={response.accounts} createdNames={result.createdAccountNames} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Import a spreadsheet"
        description="A one-time migration off the old workbook. Nothing is written until you confirm, and re-importing the same file updates rather than duplicating."
      />

      <Section title="Workbook" description="An .xlsx export. Cached values are read, not formulas.">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* Visually replaced by the Button beside it, but kept in the
              tab order and named — a keyboard user reaches the real file
              input, and a screen reader hears what it is for. */}
          <input
            ref={fileInput}
            id="import-file"
            type="file"
            aria-label="Budget workbook (.xlsx)"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => {
              const next = e.target.files?.[0];
              if (next) loadPreview(next);
            }}
          />
          <Button type="button" onClick={() => fileInput.current?.click()} disabled={busy}>
            <UploadIcon aria-hidden="true" />
            {file ? "Choose a different file" : "Choose a file"}
          </Button>
          <p className="text-sm text-text-muted">
            {busy && !preview ? "Reading…" : file ? file.name : "No file chosen."}
          </p>
        </div>
        {error ? <p className="text-sm text-negative">{error}</p> : null}
      </Section>

      {!preview ? (
        <EmptyState
          icon={FileSpreadsheetIcon}
          title="Nothing loaded yet"
          description="Choose your budget workbook and every sheet it contains will be listed here, row by row, before anything is written."
        />
      ) : (
        <>
          {preview.flags.length > 0 ? (
            <Section
              title="Before you import"
              description="Problems found in the workbook itself. Each one is explained; none is fixed for you."
            >
              <ul className="flex flex-col gap-2">
                {[...preview.flags]
                  .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1))
                  .map((flag) => (
                    <Flag key={flag.id} flag={flag} />
                  ))}
              </ul>
            </Section>
          ) : null}

          <Section
            title="Dates"
            description="The workbook holds no due dates, so every imported bill and budget starts from this date. Set real due dates on Fixed Costs afterwards."
          >
            <FieldRow label="Anchor date" htmlFor="import-anchor" className="max-w-52">
              <Input
                id="import-anchor"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
              />
            </FieldRow>
          </Section>

          <DestinationMapping
            preview={preview}
            accounts={response?.accounts ?? []}
            choices={destinations}
            onChange={(key, choice) =>
              setDestinations((current) => {
                const next = { ...current };
                if (choice === null) delete next[key];
                else next[key] = choice;
                return next;
              })
            }
          />

          <Section
            title="Income"
            description="One variant per block in the Income sheet, with a line per person."
            aside={`${preview.people.length} people`}
          >
            <div className="flex flex-col gap-4">
              {preview.variants.map((variant) => (
                <div key={variant.key}>
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium text-text">{variant.name}</h3>
                    <p className="text-xs text-text-subtle">
                      sheet total{" "}
                      {variant.spreadsheetTotalPerPayCents === null ? (
                        "—"
                      ) : (
                        <Money value={variant.spreadsheetTotalPerPayCents} />
                      )}
                    </p>
                  </div>
                  <div className="mt-1 flex flex-col">
                    {variant.lines.map((line) => (
                      <SelectableRow
                        key={line.key}
                        checked={selected.has(line.key)}
                        onChange={() => toggle(line.key)}
                        primary={line.label ? `${line.personName} — ${line.label}` : line.personName}
                        secondary={`Row ${line.sourceRow} · ${CADENCE_LABELS[line.cadence]}`}
                        trailing={<Money value={line.amountCents} />}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            title="Fixed costs"
            description="Every bill row. Subtotal rows are skipped — the app derives subtotals from category membership."
            aside={
              <SelectAll
                keys={preview.bills.map((b) => b.key)}
                selected={selected}
                onToggle={toggleMany}
              />
            }
          >
            <div className="flex flex-col gap-4">
              {preview.fixedCategories.map((category) => {
                const bills = preview.bills.filter((b) => b.categoryName === category.name);
                if (bills.length === 0) return null;
                const total = bills
                  .filter((b) => selected.has(b.key))
                  .reduce((sum, b) => sum + b.perYearCents, 0);
                return (
                  <div key={category.key}>
                    <div className="flex items-baseline justify-between gap-2">
                      <h3 className="text-sm font-medium text-text">{category.name}</h3>
                      <p className="text-xs text-text-subtle">
                        <Money value={total} />
                        /year selected
                      </p>
                    </div>
                    <div className="mt-1 flex flex-col">
                      {bills.map((bill) => (
                        <SelectableRow
                          key={bill.key}
                          checked={selected.has(bill.key)}
                          onChange={() => toggle(bill.key)}
                          flagged={!bill.defaultSelected}
                          primary={bill.name}
                          secondary={`Row ${bill.sourceRow} · ${CADENCE_LABELS[bill.frequency]}`}
                          trailing={
                            <>
                              <Money value={bill.amountCents} />
                              <span className="block text-xs text-text-subtle">
                                <Money value={bill.perYearCents} />
                                /year
                              </span>
                            </>
                          }
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="flex items-baseline justify-between gap-2 border-t border-border pt-2 text-sm font-medium text-text">
              <span>Selected total, per year</span>
              <span className="tabular-nums">
                <Money
                  value={preview.bills
                    .filter((b) => selected.has(b.key))
                    .reduce((sum, b) => sum + b.perYearCents, 0)}
                  tween
                />
              </span>
            </p>
          </Section>

          <Section
            title="Variable costs"
            description="Each item becomes a category with a monthly budget. Essentials and non-essentials come from the group they sit in."
          >
            <div className="flex flex-col">
              {preview.variableCategories.map((category) => (
                <SelectableRow
                  key={category.key}
                  checked={selected.has(category.key)}
                  onChange={() => toggle(category.key)}
                  primary={category.name}
                  secondary={`Row ${category.sourceRow} · ${category.isEssential ? "Essential" : "Non-essential"}`}
                  trailing={
                    <>
                      <Money value={category.monthlyCents} />
                      <span className="block text-xs text-text-subtle">/month</span>
                    </>
                  }
                />
              ))}
            </div>
          </Section>

          {preview.plans.map((plan) => (
            <Section
              key={plan.key}
              title={`Allocation plan — ${plan.name}`}
              description={`From the ${plan.sheet} sheet. Imported as a draft; nothing becomes active until you apply it.`}
              aside={
                <SelectAll
                  keys={plan.lines.map((l) => l.key)}
                  selected={selected}
                  onToggle={toggleMany}
                />
              }
            >
              <FieldRow
                label="Divides income variant"
                htmlFor={`plan-variant-${plan.key}`}
                className="max-w-64"
                error={planVariants[plan.key] ? undefined : "Choose the variant this plan divides."}
              >
                <Select
                  value={planVariants[plan.key] ?? ""}
                  onValueChange={(value) => setPlanVariants((current) => ({ ...current, [plan.key]: value }))}
                >
                  <SelectTrigger id={`plan-variant-${plan.key}`}>
                    <SelectValue placeholder="Choose a variant…" />
                  </SelectTrigger>
                  <SelectContent>
                    {preview.variants.map((variant) => (
                      <SelectItem key={variant.key} value={variant.key}>
                        {variant.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldRow>

              <div className="flex flex-col">
                {plan.lines.map((line) => (
                  <SelectableRow
                    key={line.key}
                    checked={selected.has(line.key)}
                    onChange={() => toggle(line.key)}
                    primary={line.label}
                    secondary={`Row ${line.sourceRow} · stage ${line.stage} · ${line.basis.replace(/_/g, " ")}${
                      line.destination ? ` → ${line.destination}` : ""
                    }`}
                    trailing={
                      line.monthlyCents === null ? (
                        <span className="text-text-subtle">—</span>
                      ) : (
                        <>
                          <Money value={line.monthlyCents} />
                          <span className="block text-xs text-text-subtle">/month</span>
                        </>
                      )
                    }
                  />
                ))}
              </div>
            </Section>
          ))}

          {preview.balances.length > 0 ? (
            <Section
              title="Balances and growth rates"
              description="From the Projections sheet. Monthly rates are compounded to an annual rate, which is how the app stores them."
            >
              <div className="flex flex-col">
                {preview.balances.map((balance) => (
                  <SelectableRow
                    key={balance.key}
                    checked={selected.has(balance.key)}
                    onChange={() => toggle(balance.key)}
                    primary={balance.accountName}
                    secondary={
                      balance.annualGrowthRate === null
                        ? `Row ${balance.sourceRow}`
                        : `Row ${balance.sourceRow} · ${(balance.annualGrowthRate * 100).toFixed(2)}% a year`
                    }
                    trailing={<Money value={balance.amountCents} />}
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {preview.ignoredSheets.length > 0 ? (
            <Section title="Sheets not imported">
              <ul className="flex flex-col gap-1 text-sm text-text-muted">
                {preview.ignoredSheets.map((ignored) => (
                  <li key={ignored.name}>
                    <span className="font-medium text-text">{ignored.name}</span> — {ignored.reason}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 flex flex-col gap-2 rounded-(--radius-card) bg-surface p-4 shadow-(--shadow-raised) md:bottom-4">
            {error ? <p className="text-sm text-negative">{error}</p> : null}
            {unmappedCount > 0 ? (
              <p className="text-sm text-text-muted">
                {unmappedCount} destination{unmappedCount === 1 ? "" : "s"} still need an account.
              </p>
            ) : null}
            {missingVariants.length > 0 ? (
              <p className="text-sm text-text-muted">
                Choose an income variant for {missingVariants.map((p) => p.name).join(", ")}.
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-text-muted">{selected.size} rows selected</p>
              <Button onClick={runImport} disabled={!canImport}>
                {busy ? "Importing…" : "Import selected rows"}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * @param {{ keys: string[], selected: Set<string>, onToggle: (keys: string[], on: boolean) => void }} props
 */
function SelectAll({ keys, selected, onToggle }) {
  const allOn = keys.every((key) => selected.has(key));
  return (
    <Button variant="ghost" size="sm" onClick={() => onToggle(keys, !allOn)}>
      {allOn ? "Deselect all" : "Select all"}
    </Button>
  );
}
