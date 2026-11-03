import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.jsx";
import { DatePicker } from "@/components/date-picker.jsx";
import { FieldRow } from "@/components/field-row.jsx";
import { MoneyInput } from "@/components/money-input.jsx";
import { InlineError } from "@/components/notice.jsx";
import { todayIso } from "@/lib/dates.js";

/** @typedef {{ id: string, name: string, type: string, latestBalance: { amountCents: number, asAt: string } | null }} BalanceAccount */

/**
 * The primary, most-frequent write in the app — one field, one confirm
 * (phases/04-accounts-people.md "/accounts"). `accountId === null` means it
 * was opened from the command palette rather than a specific row, so it shows
 * an account picker first; opened from a row, the account is fixed.
 *
 * Shared rather than per-screen: /accounts and /goals both need it, and a goal
 * whose balance is months old reports a progress figure that is quietly wrong
 * (phases/09-goals-projections.md "Palette registers ... Update balance").
 *
 * A centred dialog like every other one-form editor in the app. It was a
 * bottom sheet capped at `max-w-sm`, which on a desktop left a narrow, edgeless
 * strip glued to the bottom of the screen.
 *
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   accounts: BalanceAccount[],
 *   accountId: string | null,
 *   submitting: boolean,
 *   onSubmit: (accountId: string, data: { asAt: string, amountCents: number }) => Promise<void>,
 * }} props
 */
export function QuickBalanceSheet({ open, onOpenChange, accounts, accountId, submitting, onSubmit }) {
  const pickable = accounts.filter((a) => a.type !== "external");
  const [selectedId, setSelectedId] = useState(/** @type {string | null} */ (null));
  const [amountCents, setAmountCents] = useState(/** @type {number | null} */ (null));
  const [asAt, setAsAt] = useState(todayIso());
  const [error, setError] = useState(/** @type {string | null} */ (null));

  useEffect(() => {
    if (!open) return;
    const initialId = accountId ?? pickable[0]?.id ?? null;
    const initialAccount = pickable.find((a) => a.id === initialId) ?? null;
    setSelectedId(initialId);
    setAmountCents(initialAccount?.latestBalance?.amountCents ?? null);
    setAsAt(todayIso());
    setError(null);
    // Re-running this when `pickable` changes would blow away whatever the
    // operator has already typed — it only needs to run when the sheet
    // opens or targets a different account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, accountId]);

  const selected = pickable.find((a) => a.id === selectedId) ?? null;

  /** @param {import("react").FormEvent} e */
  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!selectedId) {
      setError("Choose an account.");
      return;
    }
    if (amountCents === null) {
      setError("Enter a balance.");
      return;
    }
    try {
      await onSubmit(selectedId, { asAt, amountCents });
      onOpenChange(false);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update balance</DialogTitle>
          <DialogDescription>
            {selected ? selected.name : "Pick an account, then enter its current balance."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {!accountId ? (
            <FieldRow label="Account" htmlFor="balance-account">
              <Select
                value={selectedId ?? undefined}
                onValueChange={(value) => {
                  setSelectedId(value);
                  const acc = pickable.find((a) => a.id === value);
                  setAmountCents(acc?.latestBalance?.amountCents ?? null);
                }}
              >
                <SelectTrigger id="balance-account" className="w-full">
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectContent>
                  {pickable.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          ) : null}
          <FieldRow label="Balance" htmlFor="balance-amount" required>
            <MoneyInput id="balance-amount" allowNegative autoFocus value={amountCents} onChange={setAmountCents} />
          </FieldRow>
          <FieldRow label="As at" htmlFor="balance-as-at">
            <DatePicker id="balance-as-at" value={asAt} onChange={setAsAt} />
          </FieldRow>
          {error ? <InlineError>{error}</InlineError> : null}
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Update balance"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
