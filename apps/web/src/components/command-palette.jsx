import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command.jsx";
import { ShortcutsDialog } from "@/components/shortcuts-dialog.jsx";
import {
  setCommandPaletteOpen,
  toggleCommandPalette,
  useCommandPaletteOpen,
  useCommands,
} from "@/lib/commands.js";
import { NAV_ITEMS } from "@/lib/nav.js";

/** @import { Command } from "@/lib/commands.js" */

const CHORD_TIMEOUT_MS = 1200;
/** @type {Array<Command['group']>} */
const GROUP_ORDER = ["Navigation", "Actions", "Recent"];

/** @param {EventTarget | null} target */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

/**
 * `Ctrl/Cmd+K` opens the palette. `?` opens the shortcut cheatsheet. `g` then
 * a letter is a chord for quick navigation — see NAV_ITEMS for the mapping.
 * Feature phases add their own entries via registerCommands(); this
 * component only ever renders what's currently registered.
 */
export function CommandPalette() {
  const open = useCommandPaletteOpen();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const navigate = useNavigate();
  const registered = useCommands();

  const chordArmed = useRef(false);
  const chordTimeout = useRef(/** @type {number | undefined} */ (undefined));

  /** @type {Command[]} */
  const navCommands = useMemo(
    () =>
      NAV_ITEMS.map((item) => ({
        id: `nav:${item.to}`,
        group: /** @type {const} */ ("Navigation"),
        label: item.label,
        icon: item.icon,
        // The chord already works from anywhere; the palette is where an
        // operator finds out it exists, so it is shown beside the entry it
        // duplicates rather than only in the `?` cheatsheet.
        shortcut: `G ${item.chord.toUpperCase()}`,
        run: () => navigate({ to: item.to }),
      })),
    [navigate],
  );

  const chordTargets = useMemo(
    () => new Map(NAV_ITEMS.map((item) => [item.chord, item])),
    [],
  );

  useEffect(() => {
    /** @param {KeyboardEvent} event */
    function onKeyDown(event) {
      const withModifier = event.metaKey || event.ctrlKey;

      if (withModifier && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggleCommandPalette();
        return;
      }

      if (isTypingTarget(event.target) || withModifier || event.altKey) return;

      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (chordArmed.current) {
        chordArmed.current = false;
        window.clearTimeout(chordTimeout.current);
        const target = chordTargets.get(event.key.toLowerCase());
        if (target) {
          event.preventDefault();
          navigate({ to: target.to });
        }
        return;
      }

      if (event.key.toLowerCase() === "g") {
        chordArmed.current = true;
        chordTimeout.current = window.setTimeout(() => {
          chordArmed.current = false;
        }, CHORD_TIMEOUT_MS);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(chordTimeout.current);
    };
  }, [chordTargets, navigate]);

  /** @type {Map<Command['group'], Command[]>} */
  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const command of [...navCommands, ...registered]) {
      const list = byGroup.get(command.group) ?? [];
      list.push(command);
      byGroup.set(command.group, list);
    }
    return byGroup;
  }, [navCommands, registered]);

  return (
    <>
      <CommandDialog loop open={open} onOpenChange={setCommandPaletteOpen}>
        <CommandInput placeholder="Search or jump to…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          {GROUP_ORDER.map((group, index) => {
            const items = groups.get(group);
            if (!items || items.length === 0) return null;
            return (
              <div key={group}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={group}>
                  {items.map((command) => (
                    <CommandItem
                      key={command.id}
                      value={`${command.label} ${command.keywords ?? ""}`}
                      onSelect={() => {
                        command.run();
                        setCommandPaletteOpen(false);
                      }}
                    >
                      {command.icon ? (
                        <command.icon className="size-4" aria-hidden="true" />
                      ) : null}
                      {command.label}
                      {command.shortcut ? <CommandShortcut>{command.shortcut}</CommandShortcut> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </div>
            );
          })}
        </CommandList>
      </CommandDialog>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </>
  );
}
