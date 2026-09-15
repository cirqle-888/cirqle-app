import { normalizeDate } from '@/lib/import/engine'
import { round2 } from '@/lib/calculations/currency'

/**
 * Turning a credit card statement into lines.
 *
 * Two ways in, one answer: text pasted out of a bank's page or PDF, and rows
 * lifted from a CSV or spreadsheet export. Both end in `ParsedLine[]`, so
 * everything downstream — matching, totalling, closing a cycle — is written
 * once.
 *
 * NOTHING HERE INVENTS A DATE. `normalizeDate` from the import engine is the
 * app's only date parser and is already day-first for the Indian calendar,
 * already tested, and already the thing every historical import trusts. A
 * second one living here is precisely how two screens start disagreeing about
 * what 06/07 means.
 *
 * THE SIGN CONVENTION, which everything downstream depends on:
 *   POSITIVE is a charge. NEGATIVE is a credit — a refund, a reversal, or the
 *   bill payment where the bank prints it on the statement. Indian statements
 *   mark these 'Cr'; some print them in brackets; some use a minus. All three
 *   are read, and a line whose sign cannot be established is REPORTED rather
 *   than guessed at, because a refund read as a charge balances a cycle that
 *   is wrong by twice its value.
 */

export interface ParsedLine {
  txnDate: string
  description: string
  /** Positive = charge, negative = credit. */
  amount: number
  /** The source text, kept verbatim so a bad parse can be seen. */
  raw: string
}

export interface ParseProblem {
  raw: string
  /** A sentence for a person, not an error code. */
  reason: string
}

export interface ParseResult {
  lines: ParsedLine[]
  problems: ParseProblem[]
  /**
   * True when at least one date could have been read either way round
   * (03/04 is 3 April or 4 March) and nothing in the batch settled it.
   * The parse still returns day-first; this exists so the screen can SAY so
   * rather than let a month-first statement land silently wrong.
   */
  datesAmbiguous: boolean
}

/* ── Money ──────────────────────────────────────────────────────────────── */

const CURRENCY = /[₹$£€]|\b(?:inr|aed|sar|qar|usd|rs)\b\.?/gi

/**
 * Read an amount and its sign.
 *
 * Returns null when there is no number at all. `credit` is null when the text
 * carries no sign marker either way — the caller decides what that means,
 * because a bare number in a "Debit" column is a charge while a bare number
 * on a pasted line is only probably one.
 */
export function readAmount(text: string): { amount: number; credit: boolean | null } | null {
  const cleaned = text.replace(CURRENCY, ' ').trim()
  if (!cleaned) return null

  // 'Cr' / 'Dr' are how Indian statements mark direction, and they may sit
  // either side of the number.
  const cr = /\bcr\b\.?/i.test(cleaned)
  const dr = /\bdr\b\.?/i.test(cleaned)
  const bracketed = /\(\s*[\d,.]+\s*\)/.test(cleaned)
  const negated = /(^|\s)-\s*[\d,]/.test(cleaned)

  const digits = cleaned.replace(/\b(cr|dr)\b\.?/gi, ' ').match(/-?\d[\d,]*(?:\.\d+)?/)
  if (!digits) return null

  const value = Number(digits[0].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null

  const credit = cr ? true : dr ? false : (bracketed || negated) ? true : null
  return { amount: round2(Math.abs(value)), credit }
}

/* ── Dates ──────────────────────────────────────────────────────────────── */

const ISO = /^\d{4}-\d{2}-\d{2}$/
/** Two numeric parts that could each be a month: '03/04/2026'. */
const AMBIGUOUS = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/

function readDate(text: string): { date: string | null; ambiguous: boolean } {
  const trimmed = text.trim()
  if (!trimmed) return { date: null, ambiguous: false }
  const normalised = normalizeDate(trimmed)
  const ok = ISO.test(normalised)
  const m = AMBIGUOUS.exec(trimmed)
  // Ambiguous only when BOTH numbers are 12 or under; anything above settles it.
  const ambiguous = Boolean(ok && m && Number(m[1]) <= 12 && Number(m[2]) <= 12)
  return { date: ok ? normalised : null, ambiguous }
}

/** A date anywhere inside a pasted line, with the rest of the line as text. */
const LEADING_DATE =
  /^\s*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\s\-/][A-Za-z]{3,}[\s\-/]\d{2,4})\s+(.*)$/

/* ── Pasted text ────────────────────────────────────────────────────────── */

/**
 * Parse lines copied out of a statement.
 *
 * The shape assumed is the one every bank's HTML table and PDF collapses to:
 * a date, then a description, then the amount last. A line that does not
 * start with a date is skipped as a header or a page footer — silently,
 * because a statement is full of them and reporting each one as a problem
 * would bury the lines that really did fail.
 */
export function parseStatementText(text: string): ParseResult {
  const lines: ParsedLine[] = []
  const problems: ParseProblem[] = []
  let ambiguous = false

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    const m = LEADING_DATE.exec(trimmed)
    if (!m) continue                       // header, footer, page number

    const date = readDate(m[1])
    if (!date.date) continue               // looked like a date and was not
    if (date.ambiguous) ambiguous = true

    const rest = m[2].trim()
    // The amount is the LAST money-looking token; a description can contain
    // digits ('AMAZON 4806505') and an account number often precedes it.
    const money = [...rest.matchAll(/(?:[₹$£€]\s*)?\(?-?\d[\d,]*\.\d{2}\)?(?:\s*(?:cr|dr)\b\.?)?/gi)]
    if (!money.length) {
      problems.push({ raw: trimmed, reason: 'No amount could be read from this line.' })
      continue
    }
    const last = money[money.length - 1]
    const read = readAmount(last[0])
    if (!read) {
      problems.push({ raw: trimmed, reason: 'The amount could not be read as a number.' })
      continue
    }

    const description = rest.slice(0, last.index).replace(/\s{2,}/g, ' ').trim()
    if (!description) {
      problems.push({ raw: trimmed, reason: 'This line has an amount but no description.' })
      continue
    }

    lines.push({
      txnDate: date.date,
      description,
      // A pasted line with no marker is a charge: statements are mostly
      // charges, and a credit almost always carries 'Cr', a minus or brackets.
      amount: read.credit === true ? -read.amount : read.amount,
      raw: trimmed,
    })
  }

  return { lines, problems, datesAmbiguous: ambiguous }
}

/* ── Tabular (CSV / spreadsheet) ────────────────────────────────────────── */

/** Which column holds what. Indexes into each row. */
export interface ColumnMap {
  date: number
  description: number
  /** A single signed amount column. */
  amount?: number
  /** Or a debit/credit pair, which is how most Indian exports are shaped. */
  debit?: number
  credit?: number
}

const HEADER_HINTS: Record<keyof ColumnMap, string[]> = {
  date: ['transaction date', 'txn date', 'date', 'value date', 'posting date'],
  description: ['description', 'transaction details', 'details', 'particulars', 'narration', 'merchant'],
  amount: ['amount', 'amount (inr)', 'transaction amount', 'amt'],
  debit: ['debit', 'withdrawal', 'dr', 'spend', 'charges'],
  credit: ['credit', 'deposit', 'cr', 'payment', 'refund'],
}

/**
 * Guess the columns from a header row.
 *
 * A guess, offered to a person to correct — never applied blind. Banks label
 * the same column five different ways, and the one time the guess is wrong is
 * the time a whole cycle lands with dates and amounts transposed.
 */
export function guessColumns(header: readonly string[]): Partial<ColumnMap> {
  const cells = header.map(h => (h ?? '').toString().trim().toLowerCase())
  const out: Partial<ColumnMap> = {}
  for (const [field, hints] of Object.entries(HEADER_HINTS) as [keyof ColumnMap, string[]][]) {
    // Exact label first, then a contains match, so 'Debit Amount' does not
    // win the 'amount' slot from a column actually called 'Amount'.
    let at = cells.findIndex(c => hints.includes(c))
    if (at === -1) at = cells.findIndex(c => c && hints.some(h => c.includes(h)))
    if (at !== -1 && !Object.values(out).includes(at)) out[field] = at
  }
  // A debit/credit pair and a single amount column are alternatives; when both
  // were guessed, the pair is the more explicit and wins.
  if (out.debit !== undefined && out.credit !== undefined) delete out.amount
  return out
}

/** Parse rows with a known column map. Row 0 is assumed already stripped. */
export function parseStatementRows(
  rows: readonly (readonly unknown[])[],
  map: ColumnMap,
): ParseResult {
  const lines: ParsedLine[] = []
  const problems: ParseProblem[] = []
  let ambiguous = false
  const cell = (row: readonly unknown[], at: number | undefined): string =>
    at === undefined ? '' : String(row[at] ?? '').trim()

  for (const row of rows) {
    const raw = row.map(c => String(c ?? '')).join(' | ').trim()
    if (!raw.replace(/\|/g, '').trim()) continue

    const date = readDate(cell(row, map.date))
    if (!date.date) {
      problems.push({ raw, reason: `“${cell(row, map.date)}” is not a date this can read.` })
      continue
    }
    if (date.ambiguous) ambiguous = true

    const description = cell(row, map.description)
    if (!description) {
      problems.push({ raw, reason: 'This row has no description.' })
      continue
    }

    let amount: number | null = null
    if (map.debit !== undefined || map.credit !== undefined) {
      // A debit/credit pair: whichever side carries a number decides the sign,
      // and the column it came from is the sign — no marker needed.
      const dr = readAmount(cell(row, map.debit))
      const cr = readAmount(cell(row, map.credit))
      if (dr && dr.amount > 0) amount = dr.amount
      else if (cr && cr.amount > 0) amount = -cr.amount
    } else {
      const read = readAmount(cell(row, map.amount))
      // A single column: its own marker decides, and a bare number is a charge.
      if (read) amount = read.credit === true ? -read.amount : read.amount
    }

    if (amount === null) {
      problems.push({ raw, reason: 'No amount could be read from this row.' })
      continue
    }
    lines.push({ txnDate: date.date, description, amount, raw })
  }

  return { lines, problems, datesAmbiguous: ambiguous }
}
