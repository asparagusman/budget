import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.jsx";

// A regression test for a defect that shipped and was invisible: the
// generated component styled its selected state with `data-active:*`
// utilities, and Radix emits `data-state="active"` and never `data-active`.
// Every one of those utilities was dead, so Settings' six tabs had no visible
// selection at all — nothing threw, nothing logged, the page just quietly
// stopped saying where you were.
//
// Re-running `pnpm dlx shadcn@latest add tabs` reintroduces it, which is
// exactly why this is a test and not only a comment in the component.

/** @param {{ defaultValue?: string }} [props] */
function renderTabs({ defaultValue = "general" } = {}) {
  return render(
    <Tabs defaultValue={defaultValue}>
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="users">Users</TabsTrigger>
      </TabsList>
      <TabsContent value="general">General settings</TabsContent>
      <TabsContent value="users">User settings</TabsContent>
    </Tabs>,
  );
}

describe("TabsTrigger", () => {
  it("styles its selected state with the attribute Radix actually sets", () => {
    renderTabs();
    const selected = screen.getByRole("tab", { name: "General" });

    expect(selected).toHaveAttribute("data-state", "active");
    expect(selected).not.toHaveAttribute("data-active");
    // The utilities have to key off `data-[state=active]`. A `data-active:`
    // variant here would match nothing.
    expect(selected.className).toContain("data-[state=active]:");
    expect(selected.className).not.toMatch(/(^|\s|:)data-active:/);
  });

  it("gives the selected tab the app's one 'selected' style", () => {
    renderTabs();
    // Not an assertion about compiled CSS — about the app deciding that a
    // selected tab looks like every other selected thing: the soft blue pill
    // the sidebar uses for the current page. The generated `bg-background`
    // was 1% of lightness away from the list's own track: applied, and still
    // invisible.
    const className = screen.getByRole("tab", { name: "General" }).className;
    expect(className).toContain("data-[state=active]:bg-accent-brand-soft");
    expect(className).toContain("data-[state=active]:text-accent-brand");
  });

  it("moves the selection when another tab is clicked", async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole("tab", { name: "Users" }));

    expect(screen.getByRole("tab", { name: "Users" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("data-state", "inactive");
    expect(screen.getByText("User settings")).toBeInTheDocument();
  });
});
