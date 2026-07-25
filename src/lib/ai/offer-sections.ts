/**
 * Section-aware pre-pass for pasted WhatsApp offer lists.
 *
 * Real client messages don't put the pack size on each line — they announce it
 * once in a header and let it stick:
 *
 *     Sunday 100gm          ← day + weight for everything below
 *
 *     Cashew 240  93
 *     Pista 149
 *     ...
 *     1kg                   ← weight changes; day carries over
 *
 *     Avil  59
 *     ...
 *     Sunday 3 page         ← how many flyer pages that day needs
 *     Monday 2 page
 *
 * The AI parser (lib/ai/offer-capture.ts) reads ONE PRODUCT PER LINE and has no
 * concept of a sticky header, so "100gm" was silently lost for all 22 products
 * and a two-day message collapsed into one undifferentiated list.
 *
 * This module does the part that must be exact — segmenting by header — with
 * plain deterministic rules, and leaves name/price extraction to the AI. Each
 * section is then parsed on its own, so the section's weight and day can be
 * applied to its products without depending on the model preserving line order.
 *
 * Deliberately NOT an AI call: header detection is a closed grammar, and a
 * model that hallucinates a section boundary would mis-tag every product under it.
 */

/** Days as clients write them, mapped to a canonical label. */
const DAY_WORDS: Record<string, string> = {
  sun: 'Sunday', sunday: 'Sunday',
  mon: 'Monday', monday: 'Monday',
  tue: 'Tuesday', tues: 'Tuesday', tuesday: 'Tuesday',
  wed: 'Wednesday', weds: 'Wednesday', wednesday: 'Wednesday',
  thu: 'Thursday', thur: 'Thursday', thurs: 'Thursday', thursday: 'Thursday',
  fri: 'Friday', friday: 'Friday',
  sat: 'Saturday', saturday: 'Saturday',
}

/**
 * A pack size on its own: "100gm", "1kg", "500 ml", "2 ltr", "12 nos".
 * Anchored, so a product line ending in a bare price ("Chips 129") can never
 * match — a unit suffix is mandatory.
 */
const WEIGHT_RE = /^(\d+(?:\.\d+)?)\s*(gm?s?|kgs?|ml|mls|ltrs?|lt|l|nos?|pcs?|pieces?|pkt?s?)$/i

/** "Sunday 3 page" / "monday 2 pages" — a layout instruction, not a product. */
const PAGE_HINT_RE = /^([a-z]+)\s+(\d+)\s*pages?$/i

export interface OfferSection {
  /** Canonical day this section belongs to, or null if the client never said one. */
  day: string | null
  /** Pack size that applies to every product in the section, or null. */
  weight: string | null
  /** Raw product lines, verbatim, ready to hand to the AI parser. */
  lines: string[]
}

export interface SectionedOffer {
  sections: OfferSection[]
  /** "Sunday 3 page" → { day: 'Sunday', pages: 3 } */
  pageHints: { day: string; pages: number }[]
  /** Distinct days seen, in the order the client wrote them. */
  days: string[]
  /** Lines that were treated as headers/instructions rather than products. */
  skipped: string[]
}

/** Normalise a weight token for display: "100 GM" → "100gm", "1 KG" → "1kg". */
function normaliseWeight(raw: string): string {
  const m = WEIGHT_RE.exec(raw.trim())
  if (!m) return raw.trim()
  const [, num, unitRaw] = m
  let unit = unitRaw.toLowerCase()
  // Collapse the common spellings so "500g", "500gm", "500 GMS" all agree —
  // otherwise the same pack size prints three ways across one flyer.
  if (/^gm?s?$/.test(unit)) unit = 'gm'
  else if (/^kgs?$/.test(unit)) unit = 'kg'
  else if (/^(ml|mls)$/.test(unit)) unit = 'ml'
  else if (/^(ltrs?|lt|l)$/.test(unit)) unit = 'ltr'
  else if (/^nos?$/.test(unit)) unit = 'nos'
  else if (/^(pcs?|pieces?)$/.test(unit)) unit = 'pcs'
  else if (/^pkt?s?$/.test(unit)) unit = 'pkt'
  return `${num}${unit}`
}

type Header = { day?: string; weight?: string }

/**
 * Classify a line as a header, or return null if it looks like a product.
 *
 * Accepts a day, a weight, or both in either order ("Sunday 100gm" and
 * "100gm Sunday" both appear in the wild). Anything with more tokens than that
 * is a product name and is left alone.
 */
function asHeader(line: string): Header | null {
  const text = line.trim()
  if (!text) return null

  const dayOf = (token: string) => DAY_WORDS[token.toLowerCase().replace(/[.,:]/g, '')]

  // Whole-line matches first. A pack size is frequently written with a space
  // ("500 GMS", "2 Ltr"), so testing token-by-token would miss it and dump the
  // header into the product list.
  if (WEIGHT_RE.test(text)) return { weight: normaliseWeight(text) }
  const dayOnly = dayOf(text)
  if (dayOnly) return { day: dayOnly }

  // Day + weight in either order, the weight itself possibly spaced.
  const tokens = text.split(/\s+/)
  if (tokens.length >= 2 && tokens.length <= 3) {
    const leadDay = dayOf(tokens[0])
    if (leadDay) {
      const rest = tokens.slice(1).join(' ')
      if (WEIGHT_RE.test(rest)) return { day: leadDay, weight: normaliseWeight(rest) }
    }
    const trailDay = dayOf(tokens[tokens.length - 1])
    if (trailDay) {
      const rest = tokens.slice(0, -1).join(' ')
      if (WEIGHT_RE.test(rest)) return { day: trailDay, weight: normaliseWeight(rest) }
    }
  }
  return null // anything else is a product line
}

/**
 * Split a pasted message into sections carrying their day and pack size.
 *
 * A new section starts whenever a header changes the running context AND the
 * current section already has products — so consecutive headers ("Sunday" then
 * "500gm") accumulate into one context instead of producing an empty section.
 */
export function splitOfferSections(text: string): SectionedOffer {
  const sections: OfferSection[] = []
  const pageHints: { day: string; pages: number }[] = []
  const days: string[] = []
  const skipped: string[] = []

  let day: string | null = null
  let weight: string | null = null
  let current: OfferSection | null = null

  const flush = () => {
    if (current && current.lines.length) sections.push(current)
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const pageMatch = PAGE_HINT_RE.exec(line)
    if (pageMatch) {
      const hintDay = DAY_WORDS[pageMatch[1].toLowerCase()]
      if (hintDay) {
        pageHints.push({ day: hintDay, pages: parseInt(pageMatch[2], 10) })
        // "Monday 2 page" may be the ONLY mention of Monday in the message —
        // it still means a Monday flyer is expected, so the day counts.
        if (!days.includes(hintDay)) days.push(hintDay)
        skipped.push(line)
        continue
      }
    }

    const header = asHeader(line)
    if (header) {
      // Context change closes the section only if it actually collected
      // products; back-to-back headers just refine the same context.
      if (current && current.lines.length) flush()
      if (header.day) {
        day = header.day
        if (!days.includes(header.day)) days.push(header.day)
      }
      if (header.weight) weight = header.weight
      skipped.push(line)
      continue
    }

    if (!current) current = { day, weight, lines: [] }
    current.lines.push(line)
  }

  flush()
  return { sections, pageHints, days, skipped }
}

/**
 * How many distinct flyer runs this message describes.
 *
 * Two days in one paste means two campaigns, not one 60-product list — the
 * single most expensive mistake to make silently.
 */
export function summariseSections(parsed: SectionedOffer): string {
  const productLines = parsed.sections.reduce((n, s) => n + s.lines.length, 0)
  const weights = [...new Set(parsed.sections.map(s => s.weight).filter(Boolean))]
  const bits = [`${productLines} product lines`, `${parsed.sections.length} section(s)`]
  if (parsed.days.length) bits.push(`days: ${parsed.days.join(', ')}`)
  if (weights.length) bits.push(`packs: ${weights.join(', ')}`)
  if (parsed.pageHints.length) {
    bits.push(`pages: ${parsed.pageHints.map(h => `${h.day}=${h.pages}`).join(', ')}`)
  }
  return bits.join(' · ')
}
