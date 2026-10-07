import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Command, CommandItem, CommandList, CommandShortcut } from "./command.jsx";

// A regression test for a defect that shipped and was invisible, the same
// class as tabs.test.jsx: the generated item styled its cursor with
// `data-selected:*`, which compiles to `[data-selected]` — attribute PRESENT.
// cmdk writes `data-selected="false"` on every row that isn't under the
// cursor, so every row matched, every row got the same fill, and arrowing
// through the palette showed nothing moving.
//
// Re-running `pnpm dlx shadcn@latest add command` reintroduces it.

function renderPalette() {
  return render(
    <Command>
      <CommandList>
        <CommandItem value="dashboard">
          Dashboard
          <CommandShortcut>G D</CommandShortcut>
        </CommandItem>
        <CommandItem value="income">Income</CommandItem>
      </CommandList>
    </Command>,
  );
}

describe("CommandItem", () => {
  it("emits data-selected on every row, true or false", () => {
    renderPalette();
    const [first, second] = screen.getAllByRole("option");

    expect(first).toHaveAttribute("data-selected", "true");
    // The reason a bare `data-selected:` variant can't work.
    expect(second).toHaveAttribute("data-selected", "false");
  });

  it("styles the cursor off the attribute's value, not its presence", () => {
    renderPalette();
    const item = screen.getByRole("option", { name: /Dashboard/ });

    expect(item.className).toContain("data-[selected=true]:bg-accent");
    expect(item.className).not.toMatch(/(^|\s|:)data-selected:/);
    expect(screen.getByText("G D").className).not.toMatch(/group-data-selected\//);
  });
});
