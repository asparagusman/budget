import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { equivalent } from "@budget/engine";
import { INCOME_TOTAL_ROWS, makeFixtureWorkbook } from "./__fixtures__/make-workbook.js";
import { parseImport } from "./parse.js";

// Two suites, and the split is deliberate.
//
// The first runs everywhere, against a synthetic workbook built by
// `__fixtures__/make-workbook.js` with the source spreadsheet's SHAPE and
// none of its figures. Everything the parser actually implements — the
// bracketed-person rule, the "& LP" rule, stage walking, the four defect
// flags, growth compounding — is a rule about shape, and it is tested here.
//
// The second runs only where `.claude/plans/Budget.xlsx` is present. That
// file is gitignored because it holds the household's real financial
// position, so this suite is reduced to the things that are genuinely about
// THAT workbook: the phase's acceptance criteria, stated as the exact
// numbers the doc states them as. It announces its own absence rather than
// skipping quietly.

const WORKBOOK = fileURLToPath(new URL("../../../../../.claude/plans/Budget.xlsx", import.meta.url));
const present = existsSync(WORKBOOK);

const MAPPED_ACCOUNTS = [
  { id: "11111111-1111-1111-1111-111111111111", name: "ubank (House)" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Raiz" },
];

describe("parseImport, against a workbook shaped like the source", () => {
  /** @type {Buffer} */
  let bytes;
  /** @type {Awaited<ReturnType<typeof parseImport>>} */
  let plan;

  beforeAll(async () => {
    // Built once and reused: two `writeBuffer()` calls produce different zip
    // bytes, and the determinism test below is about the same bytes parsing
    // the same way — not about exceljs being reproducible.
    bytes = await makeFixtureWorkbook();
    plan = await parseImport(bytes, { fileName: "fixture.xlsx", accounts: MAPPED_ACCOUNTS });
  });

  it("reads every income variant and reproduces its own stated total", () => {
    const totals = Object.fromEntries(
      plan.variants.map((v) => [
        v.name,
        v.lines.reduce((sum, l) => sum + equivalent(l.amountCents, l.cadence, "fortnightly"), 0),
      ]),
    );

    expect(Object.keys(totals)).toEqual(["Usual", "PL Gov (High)", "PL Torch (Low)", "PL Balanced"]);
    // Each variant's summed lines must equal the total the sheet itself holds
    // in its own "Total (Fortnightly)" row — the check that catches a block
    // whose boundary was read one row short.
    for (const variant of plan.variants) {
      expect(totals[variant.name]).toBe(variant.spreadsheetTotalPerPayCents);
    }
    // The first block has no title of its own and is the baseline the plan
    // sheets divide.
    expect(plan.variants[0]?.name).toBe("Usual");
    expect(plan.variants.map((v) => v.totalRow)).toEqual([
      INCOME_TOTAL_ROWS.usual,
      INCOME_TOTAL_ROWS.govHigh,
      INCOME_TOTAL_ROWS.torchLow,
      INCOME_TOTAL_ROWS.balanced,
    ]);
  });

  it("splits a bracketed person into one person with a labelled line", () => {
    expect(plan.people.map((p) => p.name).sort()).toEqual(["Ada", "Ben"]);
    const gov = plan.variants.find((v) => v.name === "PL Gov (High)")?.lines.find((l) => l.personName === "Ben");
    expect(gov?.label).toBe("Gov");
    // And it is reported, because a household member whose real name
    // contains brackets would need to know the rule ran.
    expect(plan.flags.some((f) => f.id === "person-qualifiers")).toBe(true);
  });

  it("names an '& LP' row after the row above it", () => {
    const names = plan.bills.map((b) => b.name);
    expect(names).toContain("Ambulance Cover (LP)");
    expect(names).toContain("Roadside Assist (LP)");
    expect(names).not.toContain("& LP");
    const flag = plan.flags.find((f) => f.id === "derived-bill-names-lp");
    expect(flag?.title).toBe("2 bills were named from the row above");
  });

  it("flags the unlabelled duplicate row and deselects it by default", () => {
    const duplicate = plan.bills.find((b) => b.categoryName === "Rent" && !b.defaultSelected);
    expect(duplicate).toBeDefined();
    expect(duplicate?.sourceRow).toBe(3);
    expect(duplicate?.amountCents).toBe(120_000);
    // The FIRST of the pair stays selected — a duplicate is one row too many,
    // not two rows to drop.
    expect(plan.bills.filter((b) => b.categoryName === "Rent" && b.defaultSelected)).toHaveLength(1);
    const flag = plan.flags.find((f) => f.id === `duplicate-bill:${duplicate?.key}`);
    expect(flag?.defaultDeselected).toBe(true);
    expect(flag?.detail).toContain("already on row 2");
  });

  it("flags the category subtotal that excludes its own rows", () => {
    const flag = plan.flags.find((f) => f.id === "subtotal-mismatch:Car");
    expect(flag).toBeDefined();
    // 440.00 across four rows against a hand-typed 220.00.
    expect(flag?.detail).toContain("220.00");
    expect(flag?.detail).toContain("440.00");
    // Info, not warning: the rows were always real bills, and importing them
    // all is the correct outcome.
    expect(flag?.severity).toBe("info");
    expect(flag?.defaultDeselected).toBe(false);
  });

  it("flags the two plan sheets that divide the same income row", () => {
    const flag = plan.flags.find((f) => f.id === `shared-variant:${INCOME_TOTAL_ROWS.govHigh}`);
    expect(flag).toBeDefined();
    expect(flag?.detail).toContain("PL Gov (High)");
    expect(plan.plans.filter((p) => p.variantAmbiguous).map((p) => p.sheet).sort()).toEqual([
      "PL (Gov)",
      "PL (Torch)",
    ]);
    // Nothing is guessed: the ambiguous sheets still carry their lines, they
    // just do not claim a variant.
    expect(plan.plans.filter((p) => !p.variantAmbiguous).map((p) => p.sheet).sort()).toEqual([
      "Income Division",
      "PL Balanced",
    ]);
  });

  it("totals the fixed costs it would import with the duplicate deselected", () => {
    const selected = plan.bills.filter((b) => b.defaultSelected);
    expect(selected).toHaveLength(7);
    const perYear = selected.reduce((sum, b) => sum + b.perYearCents, 0);
    // 17,240.00. The workbook's own grand total is 31,420.00, which counts
    // the duplicate rent (−14,400.00) and misses the two "& LP" rows
    // (+220.00) — so the two figures differ by exactly the two defects, and
    // this asserts that they still reconcile that way.
    expect(perYear).toBe(1_724_000);
    expect(plan.spreadsheet.fixedTotalPerYearCents).toBe(3_142_000);
    expect(perYear).toBe(3_142_000 - 1_440_000 + 22_000);
  });

  it("reads the variable-cost split the sheet's own subtotals state", () => {
    const essentials = plan.variableCategories
      .filter((c) => c.isEssential)
      .reduce((sum, c) => sum + c.monthlyCents, 0);
    const nonEssential = plan.variableCategories
      .filter((c) => !c.isEssential)
      .reduce((sum, c) => sum + c.monthlyCents, 0);

    expect(essentials).toBe(plan.spreadsheet.variableEssentialsPerMonthCents);
    expect(essentials + nonEssential).toBe(plan.spreadsheet.variableTotalPerMonthCents);
    // A quoted item name imports unquoted, and it takes its essential/
    // non-essential flag from the group it sits under, not from its name.
    expect(plan.variableCategories.find((c) => !c.isEssential)?.name).toBe("Good Life");
  });

  it("walks each plan sheet's stages rather than indexing fixed rows", () => {
    const usual = plan.plans.find((p) => p.name === "Usual");
    expect(usual?.lines.filter((l) => l.stage === 1)).toHaveLength(2);
    expect(usual?.lines.filter((l) => l.stage === 2)).toHaveLength(4);
    expect(usual?.lines.filter((l) => l.stage === 3)).toHaveLength(2);

    // PL Balanced has one more stage-2 row than the others — a flat amount
    // rather than a percentage. Parsing it, and every row after it, correctly
    // is the reason stages are walked and not indexed.
    const balanced = plan.plans.find((p) => p.name === "PL Balanced");
    expect(balanced?.lines.filter((l) => l.stage === 2)).toHaveLength(5);
    const buffer = balanced?.lines.find((l) => l.label === "PL Buffer");
    expect(buffer?.basis).toBe("fixed_amount");
    expect(buffer?.value).toBe(48_914);
    expect(balanced?.lines.filter((l) => l.stage === 3)).toHaveLength(2);
  });

  it("makes each stage-1 row an injected basis and each stage-3 row a share of remaining", () => {
    for (const sheetPlan of plan.plans) {
      const stage1 = sheetPlan.lines.filter((l) => l.stage === 1).map((l) => l.basis);
      expect(stage1).toEqual(["from_fixed_costs", "from_variable_essentials"]);
      for (const line of sheetPlan.lines.filter((l) => l.stage === 3)) {
        expect(line.basis).toBe("pct_of_remaining");
      }
    }
  });

  it("reads a plan's gross from the cached result, never by evaluating the formula", () => {
    const usual = plan.plans.find((p) => p.name === "Usual");
    // The formula is a cross-sheet reference no engine here will evaluate;
    // the only trustworthy number in the cell is the one Sheets cached.
    expect(usual?.spreadsheetGrossPerMonthCents).toBe(1_126_667);
    expect(usual?.spreadsheetGrossPerPayCents).toBe(520_000);
    expect(usual?.spreadsheetTransferTotalCents).toBe(503_000);
  });

  it("compounds the monthly growth rate up to an annual one", () => {
    const house = plan.balances.find((b) => b.accountName === "House");
    expect(house?.monthlyRate).toBe(0.0041);
    // (1 + 0.0041)^12 - 1, not 0.0041 * 12 — the difference is a fifth of a
    // percent a year, and it compounds.
    expect(house?.annualGrowthRate).toBe(0.050325);
    expect(house?.amountCents).toBe(2_540_300);
  });

  it("reports the superseded sheets as ignored rather than dropping them", () => {
    expect(plan.ignoredSheets.map((s) => s.name).sort()).toEqual(["Assets", "Income Division_OLD"]);
  });

  it("suggests an existing account for a free-text destination", () => {
    const house = plan.destinations.find((d) => d.raw === "to ubank (House)");
    expect(house?.suggestions[0]?.accountId).toBe(MAPPED_ACCOUNTS[0]?.id);
    const raiz = plan.destinations.find((d) => d.raw === "to Raiz");
    expect(raiz?.suggestions[0]?.name).toBe("Raiz");
    // A destination nothing resembles gets no suggestion rather than the
    // least-bad one — the operator maps it themselves.
    expect(plan.destinations.find((d) => d.raw === "to 2UP")?.suggestions).toEqual([]);
    // Projections names accounts too, and they go through the same mapping
    // step rather than a second one.
    expect(plan.destinations.find((d) => d.raw === "House")?.usedBy).toEqual(["Projections"]);
  });

  it("is deterministic — the same bytes produce the same hash and the same row keys", async () => {
    const second = await parseImport(bytes, { fileName: "fixture.xlsx", accounts: MAPPED_ACCOUNTS });
    expect(second.fileHash).toBe(plan.fileHash);
    expect(second.bills.map((b) => b.key)).toEqual(plan.bills.map((b) => b.key));
  });
});

// The household's own workbook lives in `.claude/plans/`, which is gitignored
// (see the repo README's "Planning docs"). What remains here is only what is
// true of that file and no other: phase 11's acceptance criteria, as numbers.
describe.skipIf(!present)("parseImport, against the real workbook", () => {
  /** @param {{ id: string, name: string }[]} [accounts] */
  async function parseFixture(accounts = []) {
    return parseImport(readFileSync(WORKBOOK), { fileName: "Budget.xlsx", accounts });
  }

  it("reproduces the Usual variant's own fortnightly total", async () => {
    const plan = await parseFixture();
    const usual = plan.variants.find((v) => v.name === "Usual");
    const total = usual?.lines.reduce((sum, l) => sum + equivalent(l.amountCents, l.cadence, "fortnightly"), 0);
    expect(total).toBe(484161);
    expect(total).toBe(usual?.spreadsheetTotalPerPayCents);
  });

  // The phase's headline acceptance criterion, as a number rather than a
  // description: "importing the workbook and deselecting the phantom rent
  // row yields fixed costs of 35,023.88".
  it("yields fixed costs of exactly 35,023.88 a year with the phantom rent row deselected", async () => {
    const plan = await parseFixture();
    const selected = plan.bills.filter((b) => b.defaultSelected);
    expect(selected).toHaveLength(18);
    const perYear = selected.reduce((sum, b) => sum + b.perYearCents, 0);
    expect(perYear).toBe(3502388);
  });

  it("reads the variable split the real sheet states", async () => {
    const plan = await parseFixture();
    const essentials = plan.variableCategories
      .filter((c) => c.isEssential)
      .reduce((sum, c) => sum + c.monthlyCents, 0);
    expect(essentials).toBe(plan.spreadsheet.variableEssentialsPerMonthCents);
    expect(essentials).toBe(211100);
    expect(
      plan.variableCategories.filter((c) => !c.isEssential).reduce((sum, c) => sum + c.monthlyCents, 0),
    ).toBe(114300);
  });

  it("finds the four known defects in the file they were found in", async () => {
    const plan = await parseFixture();
    expect(plan.flags.some((f) => f.id.startsWith("duplicate-bill:"))).toBe(true);
    // 4230.24 derived vs the workbook's hand-typed 3998.04.
    expect(plan.flags.find((f) => f.id === "subtotal-mismatch:Car")?.detail).toContain("232.20");
    expect(plan.plans.filter((p) => p.variantAmbiguous).map((p) => p.sheet).sort()).toEqual([
      "PL (Gov)",
      "PL (Torch)",
    ]);
    expect(plan.flags.some((f) => f.id === "destination-mapping")).toBe(true);
  });

  it("compounds the household's own recorded growth rate", async () => {
    const plan = await parseFixture();
    const house = plan.balances.find((b) => b.accountName === "House");
    expect(house?.monthlyRate).toBe(0.0041);
    expect(house?.annualGrowthRate).toBe(0.050325);
  });
});

describe.skipIf(present)("the real workbook", () => {
  it("is not on this machine, so only the acceptance-criteria suite is skipped", () => {
    // Deliberately a passing test with a loud name rather than a silent skip.
    // The structural suite above ran; this says what did not.
    expect(present).toBe(false);
  });
});
