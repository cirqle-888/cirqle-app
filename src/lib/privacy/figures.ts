/**
 * Finding the money on screen, so a screen-share can hide it.
 *
 * WHAT THIS IS FOR: demoing the app to staff. Amounts — revenue, payroll,
 * invoice totals, a colleague's earnings — should not be on the projector
 * while the features are being shown.
 *
 * WHY IT WORKS BY DETECTION and not by a `<Money>` component: money is
 * formatted in about fifty places in this codebase, each with its own local
 * `fmt`. Threading a component through all of them is a large, risky change
 * across the money paths, and anything missed leaks in exactly the moment it
 * matters. Detection has the opposite failure mode: it over-hides. A blurred
 * page number is a shrug; a revealed payroll figure is not.
 *
 * WHAT THIS IS NOT: security. The numbers are still in the DOM, still in the
 * page source, and still visible to anyone whose own account can see them.
 * This hides pixels from a projector. Permissions are what decide who may
 * read a figure at all.
 */

/** Glyphs. These cannot occur inside a word, so they need no boundary. */
const GLYPHS = ['₹', '$', '£', '€']

/**
 * Alphabetic currency codes (src/lib/calculations/currency.ts).
 *
 * These MUST be word-boundaried. Without it, the case-insensitive "Rs" matched
 * the tail of any ordinary word followed by a number — "Hours 150", "Orders
 * 12", "Users 3", "Filters 2", "Layers 22", "Errors 0" — and blurred the very
 * labels that make a demo comprehensible. Over-hiding is the safe direction,
 * but not so far that the app becomes unreadable.
 */
const CODES = ['AED', 'SAR', 'QAR', 'USD', 'INR', 'Rs']

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A currency marker followed by a number: "₹1,25,000", "AED 400", "$12.50",
 * "Rs 1,299.50". Also catches the compact forms this app favours — "₹1.5L",
 * "₹28.6K" — and a leading minus for a negative balance.
 */
const CURRENCY = new RegExp(
  '(?:' + GLYPHS.map(escape).join('|') + '|\\b(?:' + CODES.map(escape).join('|') + ')\\b)' +
  '\\s*-?\\d[\\d,]*(?:\\.\\d+)?\\s*[LKMCr]{0,2}',
  'i',
)

/**
 * A bare number that is almost certainly money: grouped in the Indian or
 * Western style ("1,25,000", "12,500.00"). Four-plus digits with separators
 * is not a page number, a year or a count of tasks.
 */
const GROUPED_NUMBER = /\d{1,3}(?:,\d{2,3})+(?:\.\d+)?/

/** A percentage — a contribution score is as private as the money it earns. */
const PERCENT = /\d+(?:\.\d+)?\s*%/

export interface FigureOptions {
  /** Also hide bare grouped numbers like "1,25,000". Default true. */
  groupedNumbers?: boolean
  /** Also hide percentages like "62.5%". Default true. */
  percentages?: boolean
}

/**
 * Does this text contain something that should be hidden on a shared screen?
 *
 * Deliberately generous. The cost of a false positive is a blurred word; the
 * cost of a false negative is a salary on a projector.
 */
export function containsFigure(text: string, opts: FigureOptions = {}): boolean {
  const { groupedNumbers = true, percentages = true } = opts
  if (!text) return false
  const t = text.trim()
  if (!t) return false

  if (CURRENCY.test(t)) return true
  if (groupedNumbers && GROUPED_NUMBER.test(t)) return true
  if (percentages && PERCENT.test(t)) return true
  return false
}

/**
 * Elements whose text must never be blurred even if it looks like a figure.
 *
 * An input the user is typing into is the important one: blurring a field
 * mid-edit makes the app unusable rather than discreet, and a form being
 * filled in during a demo is being filled in deliberately.
 */
const NEVER_BLUR = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE'])

/** Is this element one whose own text we are willing to blur? */
export function isBlurrable(tagName: string, hasElementChildren: boolean): boolean {
  if (NEVER_BLUR.has(tagName.toUpperCase())) return false
  // Only leaf-ish elements: blurring a container would blur a whole card,
  // including the labels that make the demo worth giving.
  return !hasElementChildren
}
