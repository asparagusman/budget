/** @import { Cents } from "@budget/engine" */

/**
 * A setup step's `href` ("/income#pay-schedules") as the path and hash a
 * router `<Link>` takes separately.
 *
 * @param {string} href
 * @returns {{ to: string, hash: string | undefined }}
 */
export function splitHref(href) {
  const at = href.indexOf("#");
  return at === -1 ? { to: href, hash: undefined } : { to: href.slice(0, at), hash: href.slice(at + 1) };
}

// The pure parts of the import screen's two read-outs: what a re-import
// would overwrite, and the transfer reconciliation after a commit.

/**
 * The overwrites a re-import will actually make with the rows as they are
 * ticked now. Each one names the preview rows that cause it (a plan's are its
 * lines), so it drops out the moment none of them is selected — listing a
 * change the operator has already opted out of would be warning about
 * nothing.
 *
 * @template {{ rowKeys: string[] }} T
 * @param {T[]} overwrites
 * @param {ReadonlySet<string>} selected
 * @returns {T[]}
 */
export function visibleOverwrites(overwrites, selected) {
  return overwrites.filter((overwrite) => overwrite.rowKeys.some((key) => selected.has(key)));
}

/**
 * @typedef {{
 *   key: string,
 *   name: string,
 *   sheetLabels: string[],
 *   spreadsheetCents: Cents | null,
 *   importedCents: Cents | null,
 *   isNoOp: boolean,
 * }} TransferRow
 * One account's line in the reconciliation: what the workbook sent it beside
 * what the app now sends it. `null` on a side that has no transfer to this
 * account at all, which is different from a transfer of $0.
 */

/**
 * Lines the workbook's transfer list up against the app's, account by
 * account.
 *
 * They used to be two independent columns — the workbook's labels in its
 * order, the app's accounts in the engine's — so reading one transfer across
 * meant matching names by eye, and an account the import created read as
 * "New account". Now each row is one account: the app's transfers in the
 * engine's order, each with the workbook rows that were mapped to the same
 * account summed beside it, then any workbook row that landed nowhere.
 *
 * @param {{
 *   spreadsheetTransfers: { label: string, amountCents: Cents, accountId: string | null, accountName: string | null }[],
 *   importedTransfers: { accountId: string, accountName: string | null, destinations: string[], perPayCents: Cents, isNoOp: boolean }[],
 * }} plan
 * @returns {TransferRow[]}
 */
export function transferRows(plan) {
  /** @type {Map<string, { label: string, amountCents: Cents, accountName: string | null }[]>} */
  const sheetByAccount = new Map();
  /** @type {TransferRow[]} */
  const unmapped = [];
  for (const [index, transfer] of plan.spreadsheetTransfers.entries()) {
    if (transfer.accountId === null) {
      unmapped.push({
        key: `sheet:${index}`,
        name: transfer.label,
        sheetLabels: [transfer.label],
        spreadsheetCents: transfer.amountCents,
        importedCents: null,
        isNoOp: false,
      });
      continue;
    }
    const list = sheetByAccount.get(transfer.accountId) ?? [];
    list.push(transfer);
    sheetByAccount.set(transfer.accountId, list);
  }

  /** @type {TransferRow[]} */
  const rows = plan.importedTransfers.map((transfer) => {
    const sheet = sheetByAccount.get(transfer.accountId) ?? [];
    sheetByAccount.delete(transfer.accountId);
    return {
      key: transfer.accountId,
      name: transfer.accountName ?? transfer.destinations.join(", "),
      sheetLabels: sheet.map((t) => t.label),
      spreadsheetCents: sheet.length > 0 ? sheet.reduce((sum, t) => sum + t.amountCents, 0) : null,
      importedCents: transfer.perPayCents,
      isNoOp: transfer.isNoOp,
    };
  });

  // Workbook transfers to an account the app sends nothing to.
  for (const [accountId, sheet] of sheetByAccount) {
    rows.push({
      key: accountId,
      name: sheet[0]?.accountName ?? sheet.map((t) => t.label).join(", "),
      sheetLabels: sheet.map((t) => t.label),
      spreadsheetCents: sheet.reduce((sum, t) => sum + t.amountCents, 0),
      importedCents: null,
      isNoOp: false,
    });
  }

  return [...rows, ...unmapped];
}
