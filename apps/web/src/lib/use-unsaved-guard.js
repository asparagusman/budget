import { useBlocker } from "@tanstack/react-router";
import { useConfirm } from "@/components/confirm-dialog.jsx";

/**
 * Blocks in-app navigation (and the browser's own close/reload prompt) while
 * a screen holds edits that aren't on the server yet.
 *
 * `shouldBlockFn` may return a promise, so the same confirmation dialog the
 * rest of the app uses answers the question — no second, browser-drawn
 * dialog with wording nobody chose.
 *
 * `enableBeforeUnload` is the flag itself rather than `true`: a clean screen
 * must not trigger Chrome's "Leave site?" prompt.
 *
 * @param {boolean} dirty
 * @param {{ title?: string, description?: string, confirmLabel?: string }} [options]
 */
export function useUnsavedGuard(dirty, options = {}) {
  const confirm = useConfirm();

  useBlocker({
    disabled: !dirty,
    enableBeforeUnload: () => dirty,
    shouldBlockFn: async () => {
      if (!dirty) return false;
      const leave = await confirm({
        title: options.title ?? "Leave with unsaved changes?",
        description: options.description ?? "The edits you've made here haven't been saved yet.",
        confirmLabel: options.confirmLabel ?? "Leave",
        cancelLabel: "Stay",
      });
      // The blocker asks "should this navigation be blocked", which is the
      // opposite of what the operator was asked.
      return !leave;
    },
  });
}
