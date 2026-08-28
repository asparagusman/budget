import { Money } from "@/components/money.jsx";

/** @import { Cents } from "@budget/engine" */

/**
 * `goodLifeFidelityCents` in plain language. The sign is the whole point and
 * it is easy to get backwards: the engine computes it as `nonEssential −
 * final remaining`, so NEGATIVE means the prize pool is bigger than the
 * non-essential target (headroom, good news) and POSITIVE means it falls
 * short (phases/08-allocation.md "Fidelity", phases/10-dashboard.md "Good
 * Life": "get the sign right").
 *
 * One component, used by both /allocation and the dashboard, so the two can
 * never end up saying opposite things about the same number.
 *
 * @param {{ cents: Cents, targetPerMonthCents: Cents }} props
 */
export function GoodLifeFidelity({ cents, targetPerMonthCents }) {
  if (cents === 0) {
    return <>Your prize pool matches the non-essential target exactly.</>;
  }
  if (cents < 0) {
    return (
      <>
        Your prize pool is <Money value={Math.abs(cents)} className="font-semibold text-positive" /> per month{" "}
        <strong>above</strong> the non-essential target of <Money value={targetPerMonthCents} />.
      </>
    );
  }
  return (
    <>
      Your prize pool is <Money value={cents} className="font-semibold text-negative" /> per month{" "}
      <strong>short</strong> of the non-essential target of <Money value={targetPerMonthCents} />.
    </>
  );
}
