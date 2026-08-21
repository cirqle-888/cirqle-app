/**
 * Task title normalisation.
 *
 * Applied on EVERY task creation, not offered as a suggestion — so it has to be
 * safe on real titles rather than merely plausible on English ones. The three
 * things it must never do:
 *
 *   • mangle scripts that have no case at all (Malayalam titles are common here:
 *     "ഓണം bumper sale" must become "ഓണം Bumper Sale", never anything else)
 *   • flatten deliberate internal capitals ("iPhone" → "Iphone", "McDonald's" →
 *     "Mcdonald's") — a brand name typed correctly is not a mistake to fix
 *   • flatten acronyms and format codes ("A3", "CQID", "B.N.")
 */

/** Joiners that stay lowercase anywhere but the first word. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'by', 'with',
  'at', 'from', 'or', 'nor', 'but', 'vs',
])

/**
 * Tidy a title: trim, collapse inner whitespace, even out spacing around dashes.
 *
 * Run before `toTitleCase`, which splits on single spaces and would otherwise
 * see empty tokens.
 */
export function cleanTitle(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*([—–-])\s*/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the token carries no case information — Malayalam, digits, punctuation. */
function isCaseless(w: string): boolean {
  return w.toLowerCase() === w.toUpperCase()
}

/**
 * Title-case a single space-separated word, leaving anything deliberate alone.
 */
function caseWord(w: string, isFirst: boolean): string {
  if (!w) return w
  if (isCaseless(w)) return w
  // Acronyms and format codes: CQID, A3, B.N.
  if (w.length > 1 && w === w.toUpperCase()) return w
  // Deliberate internal capitals: iPhone, eBay, McDonald's, JPEGs.
  if (/[A-Z]/.test(w.slice(1))) return w

  const lower = w.toLowerCase()
  if (!isFirst && SMALL_WORDS.has(lower)) return lower
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Title-case a task title.
 *
 * Small joiners stay lowercase wherever they fall, including at the end:
 * "Onam Offer Convert to A4", "Best Deals for". Only the FIRST word is forced
 * to a capital, since a title opening in lowercase reads as a mistake.
 */
export function toTitleCase(s: string): string {
  return s
    .split(' ')
    .map((w, i) => caseWord(w, i === 0))
    .join(' ')
}

/**
 * The one call task creation should use: tidy, then title-case.
 *
 * Empty/whitespace input is returned as an empty string rather than throwing —
 * the form's `required` check owns that error, not this function.
 */
export function normalizeTaskTitle(s: string | null | undefined): string {
  if (!s) return ''
  return toTitleCase(cleanTitle(s))
}
