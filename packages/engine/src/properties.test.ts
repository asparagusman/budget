// Property-based tests. Randomisation uses a small seeded PRNG (not
// `Math.random`) so a failure is reproducible from the printed seed and
// re-running the suite never flakes.
import { describe, expect, it } from "vitest";
import { divideCents, sumCents, type Cents } from "./money.js";
import { computeAllocation, type AllocationInput, type AllocationLine, type Basis } from "./allocation.js";
import { equivalent, type Cadence } from "./cadence.js";
import { toCents } from "./money.js";

// mulberry32 — tiny, deterministic, good enough for test fuzzing.
function makeRng(seed: number) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260823;
const rng = makeRng(SEED);

function randInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

describe("divideCents property: exact reconciliation", () => {
  it(`sums to exactly the total over ${500} randomised (total, weights) pairs, seed ${SEED}`, () => {
    for (let i = 0; i < 500; i++) {
      const total = randInt(-100_000, 100_000) as Cents;
      const weightCount = randInt(1, 12);
      const weights = Array.from({ length: weightCount }, () => randInt(0, 1000));
      const shares = divideCents(total, weights);
      expect(sumCents(shares as Cents[])).toBe(total);
    }
  });

  it("reconciles for a single weight", () => {
    expect(sumCents(divideCents(12345 as Cents, [1]) as Cents[])).toBe(12345);
  });

  it("reconciles when weights sum to zero", () => {
    for (let i = 0; i < 20; i++) {
      const total = randInt(-5000, 5000) as Cents;
      const weights = Array.from({ length: randInt(1, 6) }, () => 0);
      expect(sumCents(divideCents(total, weights) as Cents[])).toBe(total);
    }
  });

  it("reconciles for an empty weight list (vacuously — nothing to sum)", () => {
    expect(divideCents(500 as Cents, [])).toEqual([]);
  });
});

describe("computeAllocation property: reconciliation and unallocated", () => {
  const CADENCES: Cadence[] = ["weekly", "fortnightly", "monthly", "every_2_months", "quarterly", "every_6_months", "yearly"];
  const PCT_BASES: Basis[] = ["pct_of_gross", "pct_of_remaining"];

  function randomPlan(seedOffset: number): AllocationInput {
    const gross = toCents(randInt(1000, 20000));
    const payCadence = CADENCES[randInt(0, CADENCES.length - 1)]!;
    const stageCount = randInt(1, 4);
    const lines: AllocationLine[] = [];
    let id = 0;

    for (let stage = 1; stage <= stageCount; stage++) {
      const isFinalStage = stage === stageCount;
      const lineCount = randInt(1, 3);

      if (isFinalStage) {
        // Force the final stage to consume exactly 100% of remaining, via
        // `pct_of_remaining` lines summing to 100 — this is what makes
        // `unallocatedPerMonthCents === 0` a valid expectation.
        const cuts = distributeIntPercentages(lineCount, () => randInt(0, 100));
        for (const pct of cuts) {
          lines.push({
            id: `l${id++}_${seedOffset}`,
            stage,
            label: "final",
            basis: "pct_of_remaining",
            value: pct,
            goalPct: null,
            accountId: `acct${randInt(0, 5)}_${seedOffset}`,
          });
        }
      } else {
        for (let i = 0; i < lineCount; i++) {
          const basis = PCT_BASES[randInt(0, PCT_BASES.length - 1)]!;
          lines.push({
            id: `l${id++}_${seedOffset}`,
            stage,
            label: "mid",
            basis,
            value: randInt(1, 15),
            goalPct: randInt(0, 20),
            accountId: `acct${randInt(0, 5)}_${seedOffset}`,
          });
        }
      }
    }

    return {
      grossPerMonthCents: gross,
      payCadence,
      fixedTotalPerMonthCents: toCents(randInt(0, 3000)),
      variableEssentialsPerMonthCents: toCents(randInt(0, 2000)),
      variableNonEssentialPerMonthCents: toCents(randInt(0, 2000)),
      incomeLandingAccountId: `acct0_${seedOffset}`,
      lines,
    };
  }

  /** Splits 100 into `count` non-negative integer percentages that sum to
   * exactly 100 — largest-remainder on integers, same idea as divideCents. */
  function distributeIntPercentages(count: number, _rand: () => number): number[] {
    const base = Math.floor(100 / count);
    const shares = new Array(count).fill(base);
    let leftover = 100 - base * count;
    let i = 0;
    while (leftover > 0) {
      shares[i % count]! += 1;
      leftover--;
      i++;
    }
    return shares;
  }

  it("transfers always reconcile exactly to the pay-cadence-equivalent gross, over 500 randomised plans", () => {
    for (let i = 0; i < 500; i++) {
      const plan = randomPlan(i);
      const result = computeAllocation(plan);
      const total = sumCents(result.transfers.map((t) => t.perPayCents));
      const expected = equivalent(plan.grossPerMonthCents, "monthly", plan.payCadence);
      expect(total).toBe(expected);
    }
  });

  it("unallocatedPerMonthCents is exactly zero whenever the final stage's percentages total 100", () => {
    for (let i = 0; i < 500; i++) {
      const plan = randomPlan(i + 100_000);
      const result = computeAllocation(plan);
      expect(result.unallocatedPerMonthCents).toBe(0);
    }
  });
});
