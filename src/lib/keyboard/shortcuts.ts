/**
 * The keyboard shortcuts Cirqle actually has, in one place.
 *
 * They were all real and all invisible. ⌘K is hinted in the search trigger;
 * ⌘S submits an open task or invoice form; ⌘⇧H hides every figure on screen
 * for a shoulder-surfing moment; ⌘Z undoes a drag on the social calendar.
 * Nothing told anyone. A shortcut nobody can discover is a shortcut nobody
 * uses, and the figure-hiding one in particular is worth knowing before you
 * need it rather than after.
 *
 * This module is the registry the guide renders from. It is deliberately a
 * DESCRIPTION, not a dispatcher: each shortcut stays implemented where it
 * belongs (the palette owns ⌘K, the privacy context owns ⌘⇧H), because moving
 * them behind a central handler would mean one global keydown listener
 * deciding what every screen's Escape key does. What this does guarantee is a
 * single list to keep honest — `shortcuts.test.ts` fails if an entry here has
 * no implementation to point at.
 *
 * Pure and dependency-free.
 */

export type ShortcutScope =
  /** Works on every screen. */
  | 'global'
  /** Works on the list screens (Tasks, Invoices, Cashbook, …). */
  | 'lists'
  /** Works while a form or dialog is open. */
  | 'forms'

export interface Shortcut {
  /** Stable key for React lists and for the coverage test. */
  id: string
  /**
   * The chord, in the registry's own notation: `mod` is ⌘ on Apple platforms
   * and Ctrl elsewhere, then optional `shift`/`alt`, then the key. Rendered by
   * `formatChord`, never shown raw.
   */
  chord: string
  /** What it does, in the user's words. */
  label: string
  scope: ShortcutScope
  /**
   * Where it is implemented. Read by the coverage test, and by the next person
   * who wonders why a shortcut stopped working.
   */
  source: string
  /** Shown only to viewers who can actually use it. */
  requiresPerm?: string
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    id: 'palette',
    chord: 'mod+k',
    label: 'Search everything — pages, clients, invoices, tasks',
    scope: 'global',
    source: 'src/components/ui/command-palette.tsx',
  },
  {
    id: 'hide-figures',
    chord: 'mod+shift+h',
    label: 'Hide or show every amount on screen',
    scope: 'global',
    source: 'src/contexts/privacy-context.tsx',
  },
  {
    id: 'save-form',
    chord: 'mod+s',
    label: 'Save the open task or invoice',
    scope: 'forms',
    source: 'src/app/(dashboard)/dashboard/tasks/tasks-client.tsx',
  },
  {
    id: 'close-dialog',
    chord: 'escape',
    label: 'Close the dialog (confirmations ask you to choose)',
    scope: 'forms',
    source: 'src/components/ui/modal-overlay.tsx',
  },
  {
    id: 'cycle-dialog',
    chord: 'tab',
    label: 'Move through the dialog’s fields — focus stays inside it',
    scope: 'forms',
    source: 'src/components/ui/modal-overlay.tsx',
  },
  {
    id: 'palette-move',
    chord: 'arrowdown',
    label: 'Move through search results (↑ to go back)',
    scope: 'global',
    source: 'src/components/ui/command-palette.tsx',
  },
  {
    id: 'calendar-undo',
    chord: 'mod+z',
    label: 'Undo the last move on the Social Calendar',
    scope: 'lists',
    source: 'src/app/(dashboard)/dashboard/social-calendar/social-calendar-client.tsx',
  },
  {
    id: 'guide',
    chord: 'shift+/',
    label: 'Show this list',
    scope: 'global',
    source: 'src/components/ui/keyboard-guide.tsx',
  },
]

export const SCOPE_LABELS: Record<ShortcutScope, string> = {
  global: 'Anywhere',
  lists: 'On list screens',
  forms: 'While a form or dialog is open',
}

/** Scope order for the guide — broadest first. */
const SCOPE_ORDER: ShortcutScope[] = ['global', 'lists', 'forms']

/**
 * True on platforms whose modifier key is ⌘.
 *
 * `navigator.platform` is deprecated but still the only thing that works
 * everywhere; the modern `userAgentData` is checked first. Wrong answer is
 * cosmetic — the handlers all accept either modifier — so this never throws
 * and defaults to Ctrl.
 */
export function isApplePlatform(nav?: {
  userAgentData?: { platform?: string }
  platform?: string
  userAgent?: string
}): boolean {
  const n = nav ?? (typeof navigator === 'undefined' ? undefined : navigator as never)
  if (!n) return false
  const hint = n.userAgentData?.platform || n.platform || n.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(hint)
}

const KEY_SYMBOLS: Record<string, string> = {
  mod: '⌘',
  shift: '⇧',
  alt: '⌥',
  escape: 'Esc',
  enter: '↵',
  tab: 'Tab',
  arrowdown: '↓',
  arrowup: '↑',
  '/': '/',
}

/**
 * Render a chord for display: `mod+shift+h` → `⌘ ⇧ H` on a Mac, `Ctrl ⇧ H`
 * elsewhere.
 *
 * Returns the parts rather than a string so the guide can render each one in
 * its own `<kbd>`, which is what makes a chord readable at a glance.
 */
export function formatChord(chord: string, apple: boolean): string[] {
  return chord.split('+').map(raw => {
    const part = raw.toLowerCase()
    if (part === 'mod') return apple ? '⌘' : 'Ctrl'
    if (part === 'alt') return apple ? '⌥' : 'Alt'
    return KEY_SYMBOLS[part] ?? part.toUpperCase()
  })
}

/**
 * The shortcuts to show this viewer, grouped by scope.
 *
 * `can` gates the handful that depend on a permission, so the guide never
 * advertises something that does nothing for the person reading it.
 */
export function groupedShortcuts(
  can: (perm: string) => boolean,
): { scope: ShortcutScope; label: string; items: Shortcut[] }[] {
  return SCOPE_ORDER
    .map(scope => ({
      scope,
      label: SCOPE_LABELS[scope],
      items: SHORTCUTS.filter(s => s.scope === scope && (!s.requiresPerm || can(s.requiresPerm))),
    }))
    .filter(group => group.items.length > 0)
}
