import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";

/**
 * Move-up / move-down for one row of a manually ordered list.
 *
 * Buttons rather than drag-and-drop: these lists are a household's people
 * and accounts — five or six rows that get reordered once — and a keyboard-
 * and touch-reachable pair of buttons costs nothing to build and nothing to
 * learn. Drag would need a pointer sensor, a touch fallback and a keyboard
 * fallback to be usable by the same people.
 *
 * The row at either end has its corresponding button disabled rather than
 * hidden, so the control column does not change width down the list.
 *
 * @param {{
 *   index: number,
 *   count: number,
 *   label: string,
 *   disabled?: boolean,
 *   onMove: (direction: -1 | 1) => void,
 * }} props
 */
export function ReorderControls({ index, count, label, disabled = false, onMove }) {
  return (
    <div className="flex items-center">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Move ${label} up`}
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Move ${label} down`}
        disabled={disabled || index === count - 1}
        onClick={() => onMove(1)}
      >
        <ChevronDownIcon />
      </Button>
    </div>
  );
}
