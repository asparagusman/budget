// The data pages — tables, charts, a month of calendar — are the ones that
// run out of room at the default column width, so they get a wider one.
// Everything else (admin, import, a bill's history, not-found) is a form or a
// list that reads worse stretched across a 1920px screen.
//
// Matched on the pathname rather than declared per route, so the shell can
// decide without the router or any page knowing about it. Each entry matches
// the page itself; `prefix` ones also match every page beneath them (Goals'
// "house" tab), where `/costs/fixed` must not, or a bill's history under it
// would widen too.
/** @type {{ to: string, prefix?: boolean }[]} */
const WIDE_PAGES = [
  { to: "/" },
  { to: "/income" },
  { to: "/costs/fixed" },
  { to: "/costs/variable" },
  { to: "/allocation" },
  { to: "/goals", prefix: true },
  { to: "/projections" },
  { to: "/calendar" },
  { to: "/accounts" },
];

// Written out in full rather than assembled, so Tailwind can see both.
const WIDE = "max-w-[96rem]";
const NARROW = "max-w-6xl";

/**
 * The max-width class for the page at `pathname`, for the app shell's content
 * column: 1536px on the data pages, 1152px everywhere else.
 *
 * @param {string} pathname
 */
export function pageWidthClass(pathname) {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const wide = WIDE_PAGES.some((page) =>
    page.prefix ? path === page.to || path.startsWith(`${page.to}/`) : path === page.to,
  );
  return wide ? WIDE : NARROW;
}
