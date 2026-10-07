import { useId } from "react";
import { cn } from "@/lib/utils.js";

/**
 * One titled block of a page: a heading, an optional line saying what the
 * block is for, optional controls on the right, then its content.
 *
 * The heading sits 12px from what it names and the page puts 24–32px between
 * blocks (shell/app-shell.jsx), so a heading always reads as belonging to the
 * content below it rather than floating halfway between two cards. Before
 * this, each page set its own `<h2>` straight into the page's even 24px
 * column, and a heading was exactly as far from its own card as from the
 * previous one.
 *
 * A description wraps the controls onto their own line before it squeezes
 * itself into a narrow column beside them — on a phone, a sentence four words
 * wide next to a button is harder to read than the same sentence above it.
 * A bare title keeps short controls beside it.
 *
 * @param {{
 *   title: import("react").ReactNode,
 *   description?: import("react").ReactNode,
 *   actions?: import("react").ReactNode,
 *   id?: string,
 *   className?: string,
 *   children: import("react").ReactNode,
 * }} props
 */
export function PageSection({ title, description, actions, id, className, children }) {
  const fallbackId = useId();
  const headingId = id ?? fallbackId;

  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        {/* `flex-auto`: the title block's own width decides whether the
            controls fit beside it. A zero basis would let a squeezed title
            wrap word by word next to them instead. */}
        <div className="min-w-0 flex-auto">
          <h2 id={headingId} className="scroll-mt-4 text-base font-semibold text-text md:text-lg">
            {title}
          </h2>
          {description ? <p className="mt-0.5 max-w-3xl text-sm text-pretty text-text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A label over one group inside a section — a bill category, an account type.
 * Quieter than a section heading and tight to its list, so a page of five
 * categories reads as one section with five parts, not five sections.
 *
 * @param {{
 *   title: import("react").ReactNode,
 *   aside?: import("react").ReactNode,
 *   className?: string,
 *   children: import("react").ReactNode,
 * }} props
 */
export function PageGroup({ title, aside, className, children }) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1">
        <h3 id={headingId} className="text-sm font-semibold text-text-muted">
          {title}
        </h3>
        {aside ? <div className="text-xs text-text-subtle tabular-nums">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}
