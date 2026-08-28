import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { equivalent } from "@budget/engine";
import { parseImport } from "./parse.js";

// The source workbook lives in `.claude/plans/`, which is gitignored — it
// holds the household's real financial figures (see the repo README's
// "Planning docs"). So these tests run wherever the file is present and
// announce their own absence where it is not, rather than silently passing.
//
// They exist because phase 11's acceptance criteria name exact numbers, and
// a parser that drifts off those numbers is a parser that has quietly
// misread the sheet.
const WORKBOOK = fileURLToPath(new URL("../../../../../.claude/plans/Budget.xlsx", import.meta.url));
const present = existsSync(WORKBOOK);

/** @param {{ id: string, name: string }[]} [accounts] */
async function parseFixture(accounts = []) {
  return parseImport(readFileSync(WORKBOOK), { fileName: "Budget.xlsx", accounts });
}

describe.skipIf(!present)("parseImport, against the real workbook", () => {
  it("reads every income variant and reproduces its own fortnightly total", async () => {
    const plan = await parseFixture();
    const totals = Object.fromEntries(
      plan.variants.map((v) => [
        v.name,
        v.lines.reduce((sum, l) => sum + equivalent(l.amountCents, l.cadence, "fortnightly"), 0),
      ]),
    );

    expect(Object.keys(totals)).toEqual(["Usual", "PL Gov (High)", "PL Torch (Low)", "PL Balanced"]);
    // Each variant's summed lines must equal the total the sheet itself
    // holds in its own "Total (Fortnightly)" row.
    for (const variant of plan.variants) {
      expect(totals[variant.name]).toBe(variant.spreadsheetTotalPerPayCents);
    }
    expect(totals.Usual).toBe(484161);
  });

  it("splits a bracketed person into one person with a labelled line", async () => {
    const plan = await parseFixture();
    expect(plan.people.map((p) => p.name).sort()).toEqual(["Grace", "Lachlan"]);
    const gov = plan.variants
      .find((v) => v.name === "PL Gov (High)")
      ?.lines.find((l) => l.personName === "Grace");
    expect(gov?.label).toBe("Gov");
  });

  it("names a partner's '& LP' row after the row above it", async () => {
    const plan = await parseFixture();
    const names = plan.bills.map((b) => b.name);
    expect(names).toContain("Ambulance Cover (LP)");
    expect(names).toContain("Roadside Assist (LP)");
    expect(names).not.toContain("& LP");
  });

  it("flags the unlabelled duplicate Rent row and deselects it by default", async () => {
    const plan = await parseFixture();
    const duplicate = plan.bills.find((b) => b.categoryName === "Rent" && !b.defaultSelected);
    expect(duplicate).toBeDefined();
    expect(duplicate?.amountCents).toBe(64221);
    expect(plan.flags.some((f) => f.id.startsWith("duplicate-bill:"))).toBe(true);
  });

  it("flags the Car subtotal that excludes its own Roadside Assist rows", async () => {
    const plan = await parseFixture();
    const flag = plan.flags.find((f) => f.id === "subtotal-mismatch:Car");
    expect(flag).toBeDefined();
    // 4230.24 derived vs the workbook's hand-typed 3998.04.
    expect(flag?.detail).toContain("232.20");
  });

  it("flags the two plan sheets that divide the same income row", async () => {
    const plan = await parseFixture();
    const flag = plan.flags.find((f) => f.id.startsWith("shared-variant:"));
    expect(flag).toBeDefined();
    expect(plan.plans.filter((p) => p.variantAmbiguous).map((p) => p.sheet).sort()).toEqual([
      "PL (Gov)",
      "PL (Torch)",
    ]);
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

  it("reads the variable-cost split the sheet's own subtotals state", async () => {
    const plan = await parseFixture();
    const essentials = plan.variableCategories
      .filter((c) => c.isEssential)
      .reduce((sum, c) => sum + c.monthlyCents, 0);
    const nonEssential = plan.variableCategories
      .filter((c) => !c.isEssential)
      .reduce((sum, c) => sum + c.monthlyCents, 0);

    expect(essentials).toBe(plan.spreadsheet.variableEssentialsPerMonthCents);
    expect(essentials).toBe(211100);
    // "Good Life" imports as non-essential, per the group it sits in.
    expect(nonEssential).toBe(114300);
    expect(plan.variableCategories.find((c) => !c.isEssential)?.name).toBe("Good Life");
  });

  it("walks each plan sheet's stages rather than indexing fixed rows", async () => {
    const plan = await parseFixture();
    const usual = plan.plans.find((p) => p.name === "Usual");
    expect(usual?.lines.filter((l) => l.stage === 1)).toHaveLength(2);
    expect(usual?.lines.filter((l) => l.stage === 2)).toHaveLength(6);
    expect(usual?.lines.filter((l) => l.stage === 3)).toHaveLength(2);

    // PL Balanced has a seventh stage-2 row the others don't — the "PL
    // Buffer", a flat amount rather than a percentage. Parsing it correctly
    // is the reason stages are walked and not indexed.
    const balanced = plan.plans.find((p) => p.name === "PL Balanced");
    expect(balanced?.lines.filter((l) => l.stage === 2)).toHaveLength(7);
    const buffer = balanced?.lines.find((l) => l.label === "PL Buffer");
    expect(buffer?.basis).toBe("fixed_amount");
    expect(buffer?.value).toBe(48914);
  });

  it("makes each stage-1 row an injected basis and each stage-3 row a share of remaining", async () => {
    const plan = await parseFixture();
    for (const sheetPlan of plan.plans) {
      const stage1 = sheetPlan.lines.filter((l) => l.stage === 1).map((l) => l.basis);
      expect(stage1).toEqual(["from_fixed_costs", "from_variable_essentials"]);
      for (const line of sheetPlan.lines.filter((l) => l.stage === 3)) {
        expect(line.basis).toBe("pct_of_remaining");
      }
    }
  });

  it("compounds the monthly growth rate up to an annual one", async () => {
    const plan = await parseFixture();
    const house = plan.balances.find((b) => b.accountName === "House");
    expect(house?.monthlyRate).toBe(0.0041);
    // (1 + 0.0041)^12 - 1, not 0.0041 * 12 — the difference is a fifth of a
    // percent a year, and it compounds.
    expect(house?.annualGrowthRate).toBe(0.050325);
    expect(house?.amountCents).toBe(2540300);
  });

  it("reports the two superseded sheets as ignored rather than dropping them", async () => {
    const plan = await parseFixture();
    expect(plan.ignoredSheets.map((s) => s.name).sort()).toEqual(["Assets", "Income Division_OLD"]);
  });

  it("suggests an existing account for a free-text destination", async () => {
    const plan = await parseFixture([
      { id: "11111111-1111-1111-1111-111111111111", name: "ubank (House)" },
      { id: "22222222-2222-2222-2222-222222222222", name: "Raiz" },
    ]);
    const house = plan.destinations.find((d) => d.raw === "to ubank (House)");
    expect(house?.suggestions[0]?.accountId).toBe("11111111-1111-1111-1111-111111111111");
    const raiz = plan.destinations.find((d) => d.raw === "to Raiz");
    expect(raiz?.suggestions[0]?.name).toBe("Raiz");
  });

  it("is deterministic — the same bytes produce the same hash and the same row keys", async () => {
    const first = await parseFixture();
    const second = await parseFixture();
    expect(second.fileHash).toBe(first.fileHash);
    expect(second.bills.map((b) => b.key)).toEqual(first.bills.map((b) => b.key));
  });
});

describe.skipIf(present)("parseImport", () => {
  it("has no workbook to test against on this machine", () => {
    // Deliberately a passing test with a loud name rather than a silent skip:
    // `.claude/plans/Budget.xlsx` is gitignored, so a fresh clone genuinely
    // cannot run the suite above, and that should be visible in the output.
    expect(present).toBe(false);
  });
});
