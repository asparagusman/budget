import { cn } from "@/lib/utils.js";

/** @param {string} name */
function initials(name) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

/**
 * The signed-in person's initials in a tinted circle — the same mark in the
 * desktop sidebar's account menu and the mobile menu's footer.
 *
 * @param {{ user: import("@/lib/auth.jsx").AuthUser | null, className?: string }} props
 */
export function AccountAvatar({ user, className }) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-brand-soft text-xs font-medium text-accent-brand",
        className,
      )}
    >
      {user ? initials(user.displayName) : "?"}
    </div>
  );
}
