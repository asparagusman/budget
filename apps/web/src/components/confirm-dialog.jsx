import { createContext, useCallback, useContext, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.jsx";

/**
 * @typedef {{
 *   title: string,
 *   description?: import("react").ReactNode,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   destructive?: boolean,
 * }} ConfirmOptions
 */

/** @typedef {(options: ConfirmOptions) => Promise<boolean>} Confirm */

// The default answers "yes" for a call made outside the provider — a test
// harness rendering one screen, never the app itself, where <ConfirmProvider>
// sits above the router.
const ConfirmContext = createContext(/** @type {Confirm} */ (async () => true));

/**
 * One confirmation dialog for the whole app, reached as `await confirm({...})`
 * from wherever the destructive thing is about to happen.
 *
 * A promise rather than a component per call site because the alternative —
 * every screen carrying its own open/target/pending state beside the mutation
 * it guards — is what left archiving fire-on-click everywhere in the first
 * place. The guard has to be cheaper to add than to skip.
 *
 * This is a *confirmation*, not an undo: it does not soften a destructive
 * action, it only makes sure the operator meant it.
 *
 * @param {{ children: import("react").ReactNode }} props
 */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(/** @type {ConfirmOptions | null} */ (null));
  // Held in a ref, not state: resolving is a side effect of the dialog
  // closing, and must survive the re-render that closing causes.
  const resolveRef = useRef(/** @type {((value: boolean) => void) | null} */ (null));

  const settle = useCallback((/** @type {boolean} */ value) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setState(null);
  }, []);

  const confirm = useCallback(/** @type {Confirm} */ ((/** @type {ConfirmOptions} */ options) => {
    // A second request while one is open answers the first with "no" rather
    // than leaving its caller waiting on a promise nothing will ever settle.
    resolveRef.current?.(false);
    setState(options);
    return new Promise((resolve) => {
      resolveRef.current = resolve;
    });
  }), []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={state !== null}
        onOpenChange={(open) => {
          // Escape, the overlay, anything that isn't the confirm button: all
          // mean "no". Never assume consent from a dismissal.
          if (!open) settle(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{state?.title ?? ""}</AlertDialogTitle>
            {state?.description ? <AlertDialogDescription>{state.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{state?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
            <AlertDialogAction
              variant={state?.destructive === false ? "default" : "destructive"}
              onClick={() => settle(true)}
            >
              {state?.confirmLabel ?? "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}

/**
 * `const confirm = useConfirm()` then `if (!(await confirm({...}))) return;`
 * immediately before the mutation.
 */
export function useConfirm() {
  return useContext(ConfirmContext);
}
