import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { NAV_ITEMS } from "@/lib/nav.js";

/**
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void }} props
 */
export function ShortcutsDialog({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Desktop only — there's no keyboard to press these on a touch
            device.
          </DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2 text-sm">
          <Shortcut keys={["Ctrl/⌘", "K"]} label="Open command palette" />
          <Shortcut keys={["↑", "↓"]} label="Move through the palette's results" />
          <Shortcut keys={["Home", "End"]} label="Jump to the first or last result" />
          <Shortcut keys={["↵"]} label="Run the selected result" />
          <Shortcut keys={["?"]} label="Open this cheatsheet" />
          <Shortcut keys={["Esc"]} label="Close a dialog or sheet" />
          <div className="my-1 h-px bg-border" />
          {NAV_ITEMS.map((item) => (
            <Shortcut
              key={item.to}
              keys={["G", item.chord.toUpperCase()]}
              label={`Go to ${item.label}`}
            />
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}

/** @param {{ keys: string[], label: string }} props */
function Shortcut({ keys, label }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-text-muted">{label}</dt>
      <dd className="flex items-center gap-1">
        {keys.map((key, index) => (
          <kbd
            // Two-key chords can legitimately repeat a letter (Goals' own
            // chord is "g", same as the "g" prefix) — key by position, not
            // by label.
            key={index}
            className="rounded-(--radius-control) bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-text"
          >
            {key}
          </kbd>
        ))}
      </dd>
    </div>
  );
}
