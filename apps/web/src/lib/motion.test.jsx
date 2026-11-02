import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTweenedNumber } from "./motion.js";

// `useTweenedNumber` sits under every <Money>, so how many times it renders
// is multiplied by every figure on a page. The contract: a figure that isn't
// tweening shows its new value on the render it changes and renders once for
// it — not once with the old figure and again with the new one
// (perf-inp-plan.md, P1.4) — and a figure that is tweening starts from where
// it was and lands exactly on the new value.

/** @param {{ value: number, enabled?: boolean, renders?: number[] }} props */
function Probe({ value, enabled = true, renders }) {
  const shown = useTweenedNumber(value, { enabled });
  renders?.push(shown);
  return <output>{shown}</output>;
}

describe("useTweenedNumber", () => {
  it("never tweens the first value", () => {
    render(<Probe value={500} />);
    expect(screen.getByRole("status")).toHaveTextContent("500");
  });

  it("shows a changed value at once, in one render, when tweening is off", () => {
    /** @type {number[]} */
    const renders = [];
    const { rerender } = render(<Probe value={100} enabled={false} renders={renders} />);
    renders.length = 0;

    rerender(<Probe value={200} enabled={false} renders={renders} />);

    expect(screen.getByRole("status")).toHaveTextContent("200");
    expect(renders).toEqual([200]);
  });

  it("counts from the old value and lands exactly on the new one", async () => {
    /** @type {number[]} */
    const renders = [];
    const { rerender } = render(<Probe value={0} renders={renders} />);

    rerender(<Probe value={1000} renders={renders} />);
    // The change is shown starting from where the figure was…
    expect(screen.getByRole("status")).toHaveTextContent("0");

    // …and ends on the exact value, not an eased approximation of it.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1000"));
    expect(renders.some((n) => n > 0 && n < 1000)).toBe(true);
  });

  it("does not show a stale figure when tweening resumes after a pause", () => {
    const { rerender } = render(<Probe value={100} />);
    // While the field driving it has focus, the figure follows exactly…
    rerender(<Probe value={200} enabled={false} />);
    rerender(<Probe value={300} enabled={false} />);
    // …and on blur it must stay on 300, not jump back to the 100 it last
    // tweened to.
    rerender(<Probe value={300} />);

    expect(screen.getByRole("status")).toHaveTextContent("300");
  });
});
