import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { IntegerInput, MoneyInput, PercentInput } from "./money-input.jsx";

// The fields are controlled by a number (or null) and keep their own text, so
// these render one the way a page does: a bit of state behind it, reporting
// what it was last told.

/** @param {{ initial?: number | null, allowNegative?: boolean, onReport?: (v: number | null) => void }} props */
function Money({ initial = null, allowNegative, onReport }) {
  const [value, setValue] = useState(/** @type {number | null} */ (initial));
  return (
    <MoneyInput
      aria-label="Amount"
      allowNegative={allowNegative}
      value={value}
      onChange={(next) => {
        setValue(next);
        onReport?.(next);
      }}
    />
  );
}

describe("MoneyInput", () => {
  it("reads a pasted figure as cents", async () => {
    const onReport = vi.fn();
    render(<Money onReport={onReport} />);
    const field = screen.getByRole("textbox", { name: "Amount" });

    await userEvent.click(field);
    await userEvent.paste("$1,234.50");

    expect(onReport).toHaveBeenLastCalledWith(123_450);
    expect(field).toHaveValue("1234.50");
  });

  it("is a text field with a decimal keypad, not a number input", () => {
    render(<Money />);
    const field = screen.getByRole("textbox", { name: "Amount" });
    expect(field).toHaveAttribute("type", "text");
    expect(field).toHaveAttribute("inputmode", "decimal");
  });

  it("reports a cleared field as null, never as zero", async () => {
    const onReport = vi.fn();
    render(<Money initial={4_250} onReport={onReport} />);
    const field = screen.getByRole("textbox", { name: "Amount" });
    expect(field).toHaveValue("42.5");

    await userEvent.clear(field);

    expect(onReport).toHaveBeenLastCalledWith(null);
    expect(field).toHaveValue("");
  });

  it("keeps a half-typed figure as typed and tidies it on blur", async () => {
    const onReport = vi.fn();
    render(<Money onReport={onReport} />);
    const field = screen.getByRole("textbox", { name: "Amount" });

    await userEvent.type(field, "7.");
    expect(field).toHaveValue("7.");
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport).toHaveBeenLastCalledWith(700);

    await userEvent.tab();
    expect(field).toHaveValue("7");
  });

  it("rounds a third decimal to the cent when it is left", async () => {
    const onReport = vi.fn();
    render(<Money onReport={onReport} />);
    const field = screen.getByRole("textbox", { name: "Amount" });

    await userEvent.type(field, "12.345");
    await userEvent.tab();

    expect(field).toHaveValue("12.35");
    expect(onReport).toHaveBeenLastCalledWith(1_235);
  });

  it("refuses a minus sign and an exponent", async () => {
    render(<Money />);
    const field = screen.getByRole("textbox", { name: "Amount" });

    await userEvent.type(field, "-5e3");

    expect(field).toHaveValue("53");
  });

  it("takes a minus sign when the field allows one", async () => {
    const onReport = vi.fn();
    render(<Money allowNegative onReport={onReport} />);
    const field = screen.getByRole("textbox", { name: "Amount" });

    await userEvent.type(field, "-5");

    expect(field).toHaveValue("-5");
    expect(onReport).toHaveBeenLastCalledWith(-500);
  });

  it("steps on the arrow keys", async () => {
    const onReport = vi.fn();
    render(<Money initial={1_000} onReport={onReport} />);

    await userEvent.type(screen.getByRole("textbox", { name: "Amount" }), "{ArrowUp}{ArrowUp}");

    expect(onReport).toHaveBeenLastCalledWith(1_200);
  });

  it("shows a new value handed down from outside", () => {
    const { rerender } = render(<MoneyInput aria-label="Amount" value={1_000} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("10");

    rerender(<MoneyInput aria-label="Amount" value={null} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("");

    rerender(<MoneyInput aria-label="Amount" value={99_950} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue("999.5");
  });
});

describe("PercentInput", () => {
  it("shows a percentage multiplied up from a fraction without the float noise", () => {
    render(<PercentInput aria-label="Rate" decimals={4} value={0.07 * 100} onChange={() => {}} />);
    expect(screen.getByRole("textbox", { name: "Rate" })).toHaveValue("7");
  });
});

describe("IntegerInput", () => {
  it("refuses a decimal point, typed or pasted", async () => {
    const onChange = vi.fn();
    render(<IntegerInput aria-label="Periods" value={null} onChange={onChange} />);
    const field = screen.getByRole("textbox", { name: "Periods" });

    await userEvent.type(field, "1.8");
    expect(field).toHaveValue("18");

    await userEvent.clear(field);
    await userEvent.paste("12.5");
    expect(field).toHaveValue("");
  });
});
