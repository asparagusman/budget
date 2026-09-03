import { Component } from "react";
import { ErrorScreen } from "@/components/error-screen.jsx";

/**
 * The last line of defence, wrapping everything in main.jsx.
 *
 * The router's own `errorComponent` (see router.jsx) covers route loaders and
 * route components, which is most of the app — but not the providers mounted
 * *above* `<RouterProvider>`. A throw in one of those unmounts the whole tree
 * and leaves an empty `#root` with the reason only in the console, which is
 * indistinguishable from the app simply not loading.
 *
 * A class because `getDerivedStateFromError` has no hook equivalent; React
 * still offers no other way to catch a render error.
 *
 * @extends {Component<{ children: import("react").ReactNode }, { error: Error | null }>}
 */
export class AppErrorBoundary extends Component {
  /** @param {{ children: import("react").ReactNode }} props */
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  /** @param {Error} error */
  static getDerivedStateFromError(error) {
    return { error };
  }

  /**
   * @param {Error} error
   * @param {import("react").ErrorInfo} info
   */
  componentDidCatch(error, info) {
    // No error-reporting service by design (see infra/README.md "Health and
    // observability, kept proportionate") — the console is where a two-user
    // household app's stack traces go, but the component stack is worth
    // keeping alongside it, since the screen below deliberately hides it.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorScreen
          error={this.state.error}
          // Deliberately a reload, not a setState back to null: whatever
          // threw did so during render, so re-rendering the same tree with
          // the same state just throws again. A reload is the only honest
          // recovery from here.
          onRetry={() => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}
