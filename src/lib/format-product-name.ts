/**
 * Casing helpers for offer-list text columns (product names).
 *
 * Three modes, applied from the offer editor's bulk toolbar:
 *  - 'upper'    → EVERYTHING UPPERCASE (classic flyer shout style).
 *  - 'sentence' → First letter capital, rest lowercase.
 *  - 'title'    → Professional Title Case: every word capitalised EXCEPT
 *                 small connector words (of, with, per, and…) and measurement
 *                 tokens (500gm, 1kg, 2l, 4pcs), which stay lowercase.
 */

export type NameCaseMode = 'upper' | 'sentence' | 'title'

/** Connector words that stay lowercase in Title Case (unless they lead the name). */
const TITLE_SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'per', 'the', 'to', 'with',
])

/** Measurement tokens like 500gm / 1kg / 2.5l / 250ml / 4pcs — always lowercase. */
const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:gm|g|kg|mg|ml|l|ltr|litre|pcs|pc|nos|no|pack|pkt)$/i

export function formatProductName(name: string, mode: NameCaseMode): string {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) return name

  if (mode === 'upper') return clean.toUpperCase()

  if (mode === 'sentence') {
    const lower = clean.toLowerCase()
    return lower.charAt(0).toUpperCase() + lower.slice(1)
  }

  // Title Case
  return clean
    .split(' ')
    .map((word, i) => {
      const lower = word.toLowerCase()
      if (UNIT_TOKEN.test(lower)) return lower
      if (i > 0 && TITLE_SMALL_WORDS.has(lower)) return lower
      // Capitalise the first letter and any letter after - / ( & so compound
      // names ("Fruit & Nut", "Lime/Mango", "Multi-grain") come out right.
      return lower.replace(/(^|[-/(&.])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())
    })
    .join(' ')
}
