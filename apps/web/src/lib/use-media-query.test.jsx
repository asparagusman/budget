import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setMatchingMedia } from "../test/setup.js";
import { LG, useMediaQuery } from "./use-media-query.js";

// `useMediaQuery` exists for one narrow case: when rendering the hidden
// branch is actively wrong. A chart measures its container, and inside
// `display: none` that container is 0x0 — so `hidden lg:block` mounts a chart
// that draws nothing, silently. Responsive classes remain the default answer;
// this hook is for when both branches must not exist at once.

function Probe() {
  const isDesktop = useMediaQuery(LG);
  // Rendering only one of the two is the whole point, so the test asserts on
  // what is in the document rather than on what is visible.
  return <div>{isDesktop ? <span>chart</span> : <span>table</span>}</div>;
}

describe("useMediaQuery", () => {
  it("answers correctly on the very first render", () => {
    // Not state seeded by an effect: a false first frame would mount the
    // wrong branch, and the chart would already have measured 0x0 by the
    // time the correction arrived.
    setMatchingMedia([LG]);
    render(<Probe />);
    expect(screen.getByText("chart")).toBeInTheDocument();
    expect(screen.queryByText("table")).toBeNull();
  });

  it("renders only the branch the viewport calls for", () => {
    setMatchingMedia([]);
    render(<Probe />);
    expect(screen.getByText("table")).toBeInTheDocument();
    expect(screen.queryByText("chart")).toBeNull();
  });

  it("swaps branches when the viewport crosses the breakpoint", () => {
    setMatchingMedia([]);
    render(<Probe />);
    expect(screen.getByText("table")).toBeInTheDocument();

    act(() => setMatchingMedia([LG]));

    expect(screen.getByText("chart")).toBeInTheDocument();
    expect(screen.queryByText("table")).toBeNull();
  });
});
