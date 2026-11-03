/**
 * Puts `text` on the clipboard.
 *
 * `navigator.clipboard` only exists on a secure page — https, or localhost —
 * and the household reaches this app at plain http://budget.local, where it is
 * simply undefined. There the old select-and-copy command still works, so
 * that is the fallback. Throws when neither does, so callers can say "copy it
 * by hand" instead of pretending.
 *
 * @param {string} text
 */
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // On screen (execCommand ignores an invisible selection) but out of sight,
  // and too small to scroll the page or zoom a phone in.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.width = "1px";
  area.style.height = "1px";
  area.style.opacity = "0";
  area.style.fontSize = "16px";
  document.body.append(area);
  const focused = /** @type {HTMLElement | null} */ (document.activeElement);
  try {
    area.select();
    // Deprecated, and the only copy a non-secure page has.
    if (!document.execCommand("copy")) throw new Error("Copy failed.");
  } finally {
    area.remove();
    focused?.focus();
  }
}
