import { normalizeDate } from '@/lib/import/engine'
import { round2 } from '@/lib/calculations/currency'

/**
 * Turning a statement into lines — a credit card's or a bank account's.
 *
 * Two ways in, one answer: text pasted out of a bank's page or PDF, and rows
 * lifted from a CSV or spreadsheet export. Both end in `ParsedLine[]`, so
 * everything downstream — matching, totalling, closing a period — is written
 * once.
 *
 * NOTHING HERE INVENTS A DATE. `normalizeDate` from the import engine is the
 * app's only date parser and is already day-first for the Indian calendar,
 * already tested, and already the thing every historical import trusts. A
 * second one living here is precisely how two screens start disagreeing about
 * what 06/07 means.
 *
 * ── THE SIGN CONVENTION ─────────────────────────────────────────────────────
 *
 * ONE RULE, read the same way on both kinds of account:
 *
 *   POSITIVE moves the statement's own headline balance UP.
 *   NEGATIVE moves it DOWN.
 *
 * On a CARD the headline is what is owed, so a purchase is POSITIVE and a
 * refund or bill payment NEGATIVE. On a BANK ACCOUNT the headline is what is
 * held, so a deposit is POSITIVE and a withdrawal NEGATIVE. The same rule
 * gives opposite answers to the word "debit" on the two, which is exactly why
 * the convention is named at every call site rather than assumed.
 *
 * A line whose sign cannot be established is REPORTED rather than guessed at,
 * because a withdrawal read as a deposit moves a reconciliation by twice its
 * value and still looks tidy.
 *
 * ── THE RUNNING BALANCE ─────────────────────────────────────────────────────
 *
 * Indian bank statements print a balance after every line, and that column
 * settles the sign better than any marker can: if the balance fell by exactly
 * the amount, the money went out. `parseStatementText` in bank mode looks for
 * that chain and uses it when it holds, which is how an unmarked paste from
 * HDFC or SBI still comes through with the right signs.
 */

export type Convention = 'card' | 'bank'

export interface ParsedLine {
  txnDate: string
  description: string
  /** Positive raises the statement's headline balance; negative lowers it. */
  amount: number
  /** The balance the statement printed after this line, when it printed one. */
  balanceAfter?: number | null
  /** A cheque number, UTR or bank reference, when the export carries one. */
  reference?: string | null
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
  /**
   * Set when a pasted bank statement's running balance was found and agreed
   * with the amounts, so the screen can say the signs were checked rather
   * than assumed. Absent for cards and for pastes with no balance column.
   */
  balanceChain?: { used: boolean; checked: number; agreed: number }
}

export interface ParseOptions {
  /** Which way round the signs read. Defaults to 'card' for callers that predate banks. */
  convention?: Convention
  /**
   * The balance before the first line, when it is known. Only used in bank
   * mode, and only to settle the first line's direction — every later line is
   * settled by its predecessor.
   */
  openingBalance?: number | null
}

/* ── Money ──────────────────────────────────────────────────────────────── */

const CURRENCY = /[₹$£€]|\b(?:inr|aed|sar|qar|usd|rs)\b\.?/gi

/**
 * Read an amount and its sign marker.
 *
 * Returns null when there is no number at all. `credit` is null when the text
 * carries no marker either way — the caller decides what that means, because
 * a bare number in a "Debit" column is settled by the column it sits in while
 * a bare number on a pasted line is not settled by anything.
 *
 * NOTE `credit` here means the marker said "Cr", not "this raises the
 * balance". On a card those are the same statement; on a bank account they
 * are opposites. The mapping from marker to sign belongs to the caller.
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

/**
 * The sign a "Cr" marker implies, per convention.
 *
 * On a card a credit is a refund and lowers what is owed. On a bank account a
 * credit is money arriving and raises the balance. One line, both directions.
 */
function signedByMarker(amount: number, credit: boolean, convention: Convention): number {
  const raisesBalance = convention === 'bank' ? credit : !credit
  return raisesBalance ? amount : -amount
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

/** Every money-looking token in a string, in order. */
const MONEY_TOKEN = /(?:[₹$£€]\s*)?\(?-?\d[\d,]*\.\d{2}\)?(?:\s*(?:cr|dr)\b\.?)?/gi

/* ── Pasted text ────────────────────────────────────────────────────────── */

/** One line, broken apart but not yet given a sign. */
interface RawLine {
  raw: string
  date: string
  /** Text before the first money token taken as the amount. */
  rest: string
  tokens: { text: string; index: number }[]
}

/** Money compares to the paise; anything looser merges lines that differ. */
const SAME = 0.005

/**
 * Does the last money token on each line behave like a running balance?
 *
 * The test is arithmetic, not a guess at the layout: take the second-to-last
 * token as the amount and the last as the balance, and see whether each line's
 * balance is its predecessor's plus or minus that amount. A statement where
 * that holds for most consecutive pairs has a balance column, and the deltas
 * then give every sign for free.
 */
function readBalanceChain(lines: RawLine[]): { used: boolean; checked: number; agreed: number } {
  const usable = lines.filter(l => l.tokens.length >= 2)
  if (usable.length < 2) return { used: false, checked: 0, agreed: 0 }

  let checked = 0
  let agreed = 0
  for (let i = 1; i < usable.length; i++) {
    const prev = readAmount(usable[i - 1].tokens[usable[i - 1].tokens.length - 1].text)
    const here = readAmount(usable[i].tokens[usable[i].tokens.length - 1].text)
    const amt = readAmount(usable[i].tokens[usable[i].tokens.length - 2].text)
    if (!prev || !here || !amt) continue
    checked++
    // Two ways a pair can agree. The DIFFERENCE is the ordinary case. The SUM
    // is what a zero crossing looks like when the balance column is unsigned:
    // going from 25,827.08 to a true −24,172.92 prints as 24,172.92, and
    // 25,827.08 + 24,172.92 is exactly the 50,000 that moved. Counting only
    // the difference made a genuine balance column look unreliable precisely
    // where the account went overdrawn.
    const diff = Math.abs(round2(here.amount - prev.amount))
    const sum = Math.abs(round2(here.amount + prev.amount))
    if (Math.abs(diff - amt.amount) < SAME || Math.abs(sum - amt.amount) < SAME) agreed++
  }
  // A clear majority, not unanimity: a statement often carries one line the
  // bank itself prints out of order, and rejecting the column over it would
  // throw away the signs for every other line.
  return { used: checked > 0 && agreed / checked >= 0.6, checked, agreed }
}

/**
 * Parse lines copied out of a statement.
 *
 * The shape assumed is the one every bank's HTML table and PDF collapses to:
 * a date, then a description, then the money. A line that does not start with
 * a date is skipped as a header or a page footer — silently, because a
 * statement is full of them and reporting each one as a problem would bury the
 * lines that really did fail.
 *
 * In BANK mode the running balance is looked for first (see
 * `readBalanceChain`). When it is there the signs come from the balance moving
 * and are therefore right whatever the bank called its columns. When it is
 * not, a line needs a Dr/Cr marker, a minus or brackets — and a bare number is
 * REPORTED, because on a bank account it is genuinely unreadable.
 *
 * In CARD mode a bare number stays a charge: a card statement is mostly
 * charges and a credit almost always carries a marker.
 */
export function parseStatementText(text: string, options: ParseOptions = {}): ParseResult {
  const convention = options.convention ?? 'card'
  const lines: ParsedLine[] = []
  const problems: ParseProblem[] = []
  let ambiguous = false

  // ── Pass 1: split every line into date, text and money tokens ───────────
  const raws: RawLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    const m = LEADING_DATE.exec(trimmed)
    if (!m) continue                       // header, footer, page number

    const date = readDate(m[1])
    if (!date.date) continue               // looked like a date and was not
    if (date.ambiguous) ambiguous = true

    const rest = m[2].trim()
    const tokens = [...rest.matchAll(MONEY_TOKEN)].map(t => ({ text: t[0], index: t.index ?? 0 }))
    if (!tokens.length) {
      problems.push({ raw: trimmed, reason: 'No amount could be read from this line.' })
      continue
    }
    raws.push({ raw: trimmed, date: date.date, rest, tokens })
  }

  // ── Pass 2: decide where the amount sits, and which way it points ───────
  const chain = convention === 'bank' ? readBalanceChain(raws) : { used: false, checked: 0, agreed: 0 }
  // The SIGNED balance, which is not always what the column prints. An account
  // that goes overdrawn keeps printing a positive-looking number (Kotak does
  // this), so the magnitude alone cannot say which way a line went. Each row
  // below tries both signs for the printed figure and keeps the one the amount
  // actually reconciles — so the sign is proved per row, never assumed.
  let signedBalance: number | null = chain.used ? (options.openingBalance ?? null) : null

  for (const line of raws) {
    // With a balance column the amount is the second-to-last token; without
    // one it is the last, because a description can contain digits
    // ('AMAZON 4806505') and an account number often precedes the money.
    const hasBalance = chain.used && line.tokens.length >= 2
    const amountToken = line.tokens[line.tokens.length - (hasBalance ? 2 : 1)]
    const read = readAmount(amountToken.text)
    if (!read) {
      problems.push({ raw: line.raw, reason: 'The amount could not be read as a number.' })
      continue
    }

    const printedBalance = hasBalance
      ? readAmount(line.tokens[line.tokens.length - 1].text)?.amount ?? null
      : null

    // The balance moving is the best evidence there is, so it is asked first.
    // Both signs of the printed figure are tried: whichever one makes the move
    // equal this line's amount is the true balance, which is how an overdrawn
    // stretch printed without a minus is read correctly instead of backwards.
    let amount: number | null = null
    let balanceAfter: number | null = printedBalance
    if (hasBalance && printedBalance !== null && signedBalance !== null) {
      for (const candidate of [printedBalance, -printedBalance]) {
        const delta = round2(candidate - signedBalance)
        if (Math.abs(Math.abs(delta) - read.amount) < SAME) {
          amount = delta === 0 ? 0 : delta
          balanceAfter = candidate
          break
        }
      }
    }
    if (amount === null && read.credit !== null) {
      amount = signedByMarker(read.amount, read.credit, convention)
    }
    if (amount === null && convention === 'card') {
      amount = read.amount                 // a card's unmarked line is a charge
    }

    // BEFORE any bail-out. The balance this line printed is known even when
    // its direction is not, and it is the next line's only anchor — dropping
    // it here would turn one unreadable line into an unreadable statement.
    // When the sign could not be proved, the previous row's sign is carried
    // over: an unresolved line in the middle of an overdrawn stretch is far
    // more likely to still be overdrawn than to have jumped back into credit.
    if (balanceAfter !== null) {
      signedBalance = amount !== null
        ? balanceAfter
        : (signedBalance !== null && signedBalance < 0 ? -Math.abs(balanceAfter) : Math.abs(balanceAfter))
    }

    if (amount === null) {
      problems.push({
        raw: line.raw,
        reason: 'Cannot tell whether this is money in or out — no Dr/Cr marker, no minus, and no running balance to check it against.',
      })
      continue
    }

    const description = line.rest.slice(0, amountToken.index).replace(/\s{2,}/g, ' ').trim()
    if (!description) {
      problems.push({ raw: line.raw, reason: 'This line has an amount but no description.' })
      continue
    }

    lines.push({
      txnDate: line.date,
      description,
      amount: round2(amount),
      balanceAfter,
      reference: null,
      raw: line.raw,
    })
  }

  return {
    lines,
    problems,
    datesAmbiguous: ambiguous,
    ...(convention === 'bank' ? { balanceChain: chain } : {}),
  }
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
  /** The running balance after the line, when the export carries one. */
  balance?: number
  /** A cheque number, UTR or bank reference. */
  reference?: number
}

/**
 * Column labels, MOST SPECIFIC FIRST — the order is the logic.
 *
 * A column is claimed once, so whichever field asks first wins it. HDFC calls
 * its columns 'Withdrawal Amt.' and 'Deposit Amt.', and the generic 'amt' hint
 * matches both; asking for `amount` before `debit` therefore ate the
 * withdrawal column and left the statement with no debit side at all. The
 * pair asks first, and `amount` only ever gets a column neither of them
 * wanted. `description` likewise asks before `credit`, because the substring
 * 'cr' is sitting inside the word 'Description'.
 */
const HEADER_HINTS: [keyof ColumnMap, string[]][] = [
  ['date',        ['transaction date', 'txn date', 'date', 'value date', 'posting date']],
  ['description', ['description', 'transaction details', 'details', 'particulars', 'narration', 'merchant', 'remarks']],
  ['balance',     ['closing balance', 'running balance', 'balance (inr)', 'balance', 'bal']],
  ['reference',   ['chq./ref.no.', 'reference', 'ref no.', 'ref no', 'cheque no', 'chq no', 'utr', 'transaction id']],
  ['debit',       ['money out', 'withdrawal amt.', 'withdrawal amt', 'withdrawal', 'withdrawals', 'debit', 'paid out', 'spend', 'charges', 'dr']],
  ['credit',      ['money in', 'deposit amt.', 'deposit amt', 'deposit', 'deposits', 'credit', 'paid in', 'payment', 'refund', 'cr']],
  ['amount',      ['amount (inr)', 'transaction amount', 'amount', 'amt']],
]

/**
 * Guess the columns from a header row.
 *
 * A guess, offered to a person to correct — never applied blind. Banks label
 * the same column five different ways, and the one time the guess is wrong is
 * the time a whole period lands with dates and amounts transposed.
 */
export function guessColumns(header: readonly string[]): Partial<ColumnMap> {
  // Underscores collapse to spaces so the app's own template headers
  // ('money_in', 'txn_date') read the same as a bank's ('Money In').
  const cells = header.map(h => (h ?? '').toString().trim().toLowerCase().replace(/_/g, ' '))
  const out: Partial<ColumnMap> = {}
  for (const [field, hints] of HEADER_HINTS) {
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
  options: ParseOptions = {},
): ParseResult {
  const convention = options.convention ?? 'card'
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
      // and the column it came from is the sign — no marker needed. Which way
      // the column points is the convention's business, not the column's.
      const dr = readAmount(cell(row, map.debit))
      const cr = readAmount(cell(row, map.credit))
      if (dr && dr.amount > 0) amount = signedByMarker(dr.amount, false, convention)
      else if (cr && cr.amount > 0) amount = signedByMarker(cr.amount, true, convention)
    } else {
      const read = readAmount(cell(row, map.amount))
      if (read) {
        if (read.credit !== null) amount = signedByMarker(read.amount, read.credit, convention)
        // A single unmarked column on a card is a charge. On a bank account it
        // could be either way and is reported below rather than guessed at.
        else if (convention === 'card') amount = read.amount
      }
    }

    if (amount === null) {
      problems.push({
        raw,
        reason: convention === 'bank'
          ? 'Cannot tell whether this row is money in or out. Map separate withdrawal and deposit columns, or use a signed amount.'
          : 'No amount could be read from this row.',
      })
      continue
    }

    const balance = map.balance !== undefined ? readAmount(cell(row, map.balance)) : null
    const reference = cell(row, map.reference)
    lines.push({
      txnDate: date.date,
      description,
      amount: round2(amount),
      balanceAfter: balance ? balance.amount : null,
      reference: reference || null,
      raw,
    })
  }

  return { lines, problems, datesAmbiguous: ambiguous }
}
