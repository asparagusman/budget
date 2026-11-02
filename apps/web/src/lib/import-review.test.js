import { describe, expect, it } from "vitest";
import { splitHref, transferRows, visibleOverwrites } from "./import-review.js";

describe("splitHref", () => {
  it("separates a hash from its path, and leaves a plain path alone", () => {
    expect(splitHref("/income#pay-schedules")).toEqual({ to: "/income", hash: "pay-schedules" });
    expect(splitHref("/costs/fixed")).toEqual({ to: "/costs/fixed", hash: undefined });
  });
});

describe("visibleOverwrites", () => {
  const overwrites = [
    { rowKeys: ["bill:power"], name: "Power" },
    { rowKeys: ["plan:a:1", "plan:a:2"], name: "Plan A" },
  ];

  it("keeps an overwrite while any of its rows is selected", () => {
    expect(visibleOverwrites(overwrites, new Set(["bill:power", "plan:a:2"]))).toEqual(overwrites);
  });

  it("drops an overwrite once none of its rows is selected", () => {
    expect(visibleOverwrites(overwrites, new Set(["plan:a:1"])).map((o) => o.name)).toEqual(["Plan A"]);
    expect(visibleOverwrites(overwrites, new Set())).toEqual([]);
  });
});

describe("transferRows", () => {
  it("lines the workbook's transfers up with the app's, account by account", () => {
    const rows = transferRows({
      spreadsheetTransfers: [
        { label: "to ubank (Bills)", amountCents: 120_000, accountId: "bills", accountName: "Bills" },
        { label: "to ubank (House)", amountCents: 50_000, accountId: "house", accountName: "House" },
        { label: "to House extra", amountCents: 5_000, accountId: "house", accountName: "House" },
        { label: "Cash", amountCents: 2_000, accountId: null, accountName: null },
        { label: "to Old savings", amountCents: 1_000, accountId: "old", accountName: "Old savings" },
      ],
      importedTransfers: [
        { accountId: "house", accountName: "House", destinations: ["to ubank (House)"], perPayCents: 55_000, isNoOp: false },
        { accountId: "bills", accountName: "Bills", destinations: ["to ubank (Bills)"], perPayCents: 120_000, isNoOp: true },
        { accountId: "new", accountName: null, destinations: ["to Holiday", "to Trips"], perPayCents: 3_000, isNoOp: false },
      ],
    });

    expect(rows).toEqual([
      // Two workbook rows mapped to one account are summed against it.
      { key: "house", name: "House", sheetLabels: ["to ubank (House)", "to House extra"], spreadsheetCents: 55_000, importedCents: 55_000, isNoOp: false },
      { key: "bills", name: "Bills", sheetLabels: ["to ubank (Bills)"], spreadsheetCents: 120_000, importedCents: 120_000, isNoOp: true },
      // No name to show: the workbook's own words, never "New account".
      { key: "new", name: "to Holiday, to Trips", sheetLabels: [], spreadsheetCents: null, importedCents: 3_000, isNoOp: false },
      // The workbook sent money to an account the app now sends nothing.
      { key: "old", name: "Old savings", sheetLabels: ["to Old savings"], spreadsheetCents: 1_000, importedCents: null, isNoOp: false },
      // Mapped nowhere at all.
      { key: "sheet:3", name: "Cash", sheetLabels: ["Cash"], spreadsheetCents: 2_000, importedCents: null, isNoOp: false },
    ]);
  });
});
