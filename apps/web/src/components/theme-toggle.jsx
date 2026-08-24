import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { useTheme } from "@/lib/theme.jsx";

/** @type {Array<{ value: import("@/lib/theme.jsx").ThemePref, label: string, Icon: typeof Sun }>} */
const OPTIONS = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/**
 * Three-way Light / Dark / System control. A binary switch can't express
 * "follow my device", which the phase spec calls out as a hard requirement.
 *
 * @param {{ className?: string }} props
 */
export function ThemeToggle({ className }) {
  const { pref, setPref } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full bg-surface-muted p-1",
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = pref === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => setPref(value)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
              active
                ? "bg-surface text-accent-brand shadow-[0_1px_2px_var(--border)]"
                : "hover:text-text",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
