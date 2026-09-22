import { round2 } from '@/lib/calculations/currency'

/**
 * Matching statement lines to what the app recorded.
 *
 * THE CASE THAT MAKES THIS INTERESTING is the split. One charge is often
 * several entries, because a single card payment gets broken up so each part
 * can carry its own category and client:
 *
 *   statement   715.84  GODADDY
 *   app         434.13  Hosting  (Cirqle.work)
 *   app         281.71  Domain   (Cirqle.work)
 *
 * So a line matches a SET of entries summing to its amount, not one entry.
 * That is a subset-sum, which is exponential in general — and is kept cheap
 * here by the only two things that make it tractable and also make it
 * correct: candidates are confined to a few days either side of the charge,
 * and a set is capped at a handful of entries. A "match" assembled from nine
 * entries across three weeks is not a match anybody could check.
 *
 * NOTHING IS APPLIED. Every function here PROPOSES. A proposal with the wrong
 * entries in it costs a person one glance; a proposal applied silently costs
 * them a reconciled cycle that is quietly wrong, which is worse than no
 * reconciliation at all.
 */

/** A line as the statement gave it. Positive is a charge. */
export interface StatementLine {
  id: string
  txnDate: string
  description: string
  amount: number
}

/** A cashbook entry on the card, as a candidate for matching. */
export interface EntryCandidate {
  id: string
  entryDate: string
  description: string
  /** Signed like the statement: an outflow on the card is a positive charge. */
  amount: number
  /** Already matched to another line — offered to nobody. */
  taken?: boolean
}

export type Confidence = 'exact' | 'likely' | 'split' | 'none'

export interface Proposal {
  lineId: string
  entryIds: string[]
  confidence: Confidence
  /** Plain words for why, shown beside the proposal. */
  reason: string
  /** Days between the charge and the entry (the furthest, for a split). */
  dayGap: number
}

/** Money compares to the paise; anything looser merges charges that differ. */
const SAME = 0.005

function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')
  return Number.isFinite(ms) ? Math.abs(Math.round(ms / 86_400_000)) : Number.MAX_SAFE_INTEGER
}

/** Comparable words from a description: lowercase, letters and digits only. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w.length > 2)
}

/**
 * Do these two descriptions share a distinctive word?
 *
 * Deliberately weak — a bank writes "GODADDY.COM 4806505" where a person
 * wrote "Domain renewal (Cirqle.work)", and demanding more than one shared
 * word would reject almost every real pair. It only ever RAISES confidence in
 * something the amount already agreed on; it never creates a match by itself.
 */
function shareAWord(a: string, b: string): boolean {
  const set = new Set(words(a))
  return words(b).some(w => set.has(w))
}

export interface MatchOptions {
  /** How many days either side of the charge an entry may sit. */
  windowDays?: number
  /** Most entries a single split may be assembled from. */
  maxSplit?: number
}

/**
 * Propose a match for one line.
 *
 * Tried in order, and the first answer wins, because each step is strictly
 * weaker evidence than the one before it:
 *   1. one entry, same amount, same day
 *   2. one entry, same amount, within the window — nearest day first
 *   3. several entries summing to the amount, within the window
 */
export function proposeForLine(
  line: StatementLine,
  candidates: readonly EntryCandidate[],
  options: MatchOptions = {},
): Proposal {
  const windowDays = options.windowDays ?? 4
  const maxSplit = Math.max(2, Math.min(options.maxSplit ?? 4, 6))

  const near = candidates
    .filter(c => !c.taken && daysBetween(line.txnDate, c.entryDate) <= windowDays)
    .map(c => ({ ...c, gap: daysBetween(line.txnDate, c.entryDate) }))
    .sort((a, b) => a.gap - b.gap)

  const none: Proposal = { lineId: line.id, entryIds: [], confidence: 'none', reason: '', dayGap: 0 }
  if (!near.length) return none

  // 1 & 2 — a single entry for the whole amount.
  const singles = near.filter(c => Math.abs(c.amount - line.amount) < SAME)
  if (singles.length) {
    const best = singles[0]
    const sameDay = best.gap === 0
    const named = shareAWord(line.description, best.description)
    return {
      lineId: line.id,
      entryIds: [best.id],
      confidence: sameDay || named ? 'exact' : 'likely',
      reason: sameDay
        ? 'same amount, same day'
        : named
          ? `same amount, ${best.gap} day${best.gap === 1 ? '' : 's'} apart, and the wording matches`
          : `same amount, ${best.gap} day${best.gap === 1 ? '' : 's'} apart`,
      dayGap: best.gap,
    }
  }

  // 3 — a split. Only charges, and only entries smaller than the line: a
  // refund inside a split is a different thing and needs a person.
  const parts = near.filter(c =>
    Math.sign(c.amount) === Math.sign(line.amount) &&
    Math.abs(c.amount) < Math.abs(line.amount) + SAME)
  const subset = findSubset(parts, line.amount, maxSplit)
  if (subset) {
    const gap = Math.max(...subset.map(s => s.gap))
    return {
      lineId: line.id,
      entryIds: subset.map(s => s.id),
      confidence: 'split',
      reason: `${subset.length} entries adding up to ${round2(line.amount)}`,
      dayGap: gap,
    }
  }

  return none
}

/**
 * The smallest set of entries summing to `target`.
 *
 * Smallest first on purpose: two entries that add up is far more likely to be
 * a real split than four that happen to. Within a size, the tightest group of
 * dates wins for the same reason.
 *
 * Bounded by `maxSize` and by the candidate list the caller already narrowed
 * to a date window, so the search cannot run away. Above a sane number of
 * candidates it gives up rather than grinding — a cycle with sixty entries in
 * one four-day window is not a reconciliation this should be guessing at.
 */
function findSubset<T extends { id: string; amount: number; gap: number }>(
  items: readonly T[],
  target: number,
  maxSize: number,
): T[] | null {
  if (items.length > 24) return null

  let best: T[] | null = null
  const chosen: T[] = []

  const walk = (from: number, sum: number) => {
    if (best && chosen.length >= best.length) return
    if (chosen.length >= 2 && Math.abs(sum - target) < SAME) {
      best = [...chosen]
      return
    }
    if (chosen.length >= maxSize) return
    for (let i = from; i < items.length; i++) {
      const next = sum + items[i].amount
      // Amounts are same-signed here, so an overshoot can only get worse.
      if (Math.abs(next) > Math.abs(target) + SAME) continue
      chosen.push(items[i])
      walk(i + 1, next)
      chosen.pop()
    }
  }

  // Tightest dates first, so an equally sized match nearer the charge wins.
  walk(0, 0)
  return best
}

export interface Reconciliation {
  proposals: Proposal[]
  /** Lines nothing could be proposed for — the charges not yet recorded. */
  unmatchedLineIds: string[]
  /** Entries on the card that no line claimed — recorded but not billed. */
  unclaimedEntryIds: string[]
}

/**
 * Propose matches for a whole cycle.
 *
 * Confident answers are taken FIRST and their entries withdrawn, so a split
 * cannot quietly consume an entry that was the exact answer to another line.
 * Doing it in one pass, line by line in statement order, is how a
 * reconciliation ends up with two plausible-looking wrong answers.
 */
export function reconcile(
  lines: readonly StatementLine[],
  entries: readonly EntryCandidate[],
  options: MatchOptions = {},
): Reconciliation {
  const taken = new Set(entries.filter(e => e.taken).map(e => e.id))
  const proposals = new Map<string, Proposal>()

  const available = (): EntryCandidate[] =>
    entries.filter(e => !taken.has(e.id)).map(e => ({ ...e, taken: false }))

  // Singles before splits, and same-day before merely nearby.
  for (const only of [['exact'], ['likely'], ['split']] as Confidence[][]) {
    for (const line of lines) {
      if (proposals.has(line.id)) continue
      const p = proposeForLine(line, available(), options)
      if (p.confidence === 'none' || !only.includes(p.confidence)) continue
      proposals.set(line.id, p)
      for (const id of p.entryIds) taken.add(id)
    }
  }

  return {
    proposals: [...proposals.values()],
    unmatchedLineIds: lines.filter(l => !proposals.has(l.id)).map(l => l.id),
    unclaimedEntryIds: entries.filter(e => !taken.has(e.id) && !e.taken).map(e => e.id),
  }
}

/** Does the cycle add up? The question closing a statement turns on. */
export function cycleBalance(
  lines: readonly StatementLine[],
  statementTotal: number | null,
): { linesTotal: number; statementTotal: number | null; difference: number | null; agrees: boolean } {
  const linesTotal = round2(lines.reduce((sum, l) => sum + l.amount, 0))
  if (statementTotal === null) {
    return { linesTotal, statementTotal: null, difference: null, agrees: false }
  }
  const difference = round2(linesTotal - statementTotal)
  return { linesTotal, statementTotal, difference, agrees: Math.abs(difference) < SAME }
}

/* ── Why a line did not match ────────────────────────────────────────────── */

/**
 * "Unmatched" is not an answer a person can act on.
 *
 * A line that found no entry is one of a handful of quite different
 * situations, and they need quite different fixing:
 *
 *   · the amount is right but the date is weeks away — the entry was recorded
 *     late, or against the wrong month;
 *   · the date is right but the amount is off by a little — a fee, a rounding,
 *     or a typo in the entry;
 *   · an entry of exactly this size exists pointing the OTHER WAY — money in
 *     was recorded as money out, which is the error that moves a
 *     reconciliation by twice the amount and still looks tidy;
 *   · nothing resembles it at all — the transaction was simply never recorded.
 *
 * Only the last of those is "missing". The other three are already in the
 * books and wrong, which is the harder thing to find by eye and the reason
 * this function exists.
 */
export type HintKind =
  | 'outside-window'
  | 'wrong-direction'
  | 'amount-differs'
  | 'nothing-near'

export interface Hint {
  lineId: string
  kind: HintKind
  /** The entry this is talking about, when there is one. */
  entryId: string | null
  /** A sentence for a person, not an error code. */
  message: string
  /** line − entry, when both exist. Positive means the statement is larger. */
  difference: number | null
  dayGap: number | null
}

/** How close two amounts must be before "nearly the same" is worth saying. */
function nearlySame(a: number, b: number): boolean {
  const gap = Math.abs(Math.abs(a) - Math.abs(b))
  if (gap < SAME) return false                        // that is the same, not near
  return gap <= Math.max(50, Math.abs(a) * 0.05)      // ₹50, or 5% on bigger sums
}

function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`
}

/**
 * Explain each line that found nothing.
 *
 * Candidates are the entries still unclaimed — an entry already matched to
 * another line is not an explanation for this one. The search deliberately
 * looks FURTHER than the matcher does (a wide multiple of its window), because
 * the whole point is to find the entry that is in the wrong place.
 */
export function explainUnmatched(
  lines: readonly StatementLine[],
  candidates: readonly EntryCandidate[],
  options: MatchOptions = {},
): Hint[] {
  const windowDays = options.windowDays ?? 4
  const wide = windowDays * 10
  const free = candidates.filter(c => !c.taken)

  return lines.map(line => {
    const near = free
      .map(c => ({ ...c, gap: daysBetween(line.txnDate, c.entryDate) }))
      .filter(c => c.gap <= wide)
      .sort((a, b) => a.gap - b.gap)

    const base = { lineId: line.id, entryId: null, difference: null, dayGap: null }

    // 1. The same money, recorded too far away for the matcher to reach.
    const sameAmount = near.find(c => Math.abs(c.amount - line.amount) < SAME)
    if (sameAmount) {
      return {
        ...base,
        kind: 'outside-window' as const,
        entryId: sameAmount.id,
        difference: 0,
        dayGap: sameAmount.gap,
        message: `The same ${round2(Math.abs(line.amount))} is recorded as “${sameAmount.description || 'no description'}” on ${sameAmount.entryDate} — ${days(sameAmount.gap)} from this line. Check the entry's date.`,
      }
    }

    // 2. The same money, pointing the other way. Checked before "nearly the
    //    same amount" because it is exact evidence and a worse mistake.
    const flipped = near.find(c => Math.abs(c.amount + line.amount) < SAME)
    if (flipped) {
      return {
        ...base,
        kind: 'wrong-direction' as const,
        entryId: flipped.id,
        difference: round2(line.amount - flipped.amount),
        dayGap: flipped.gap,
        message: `“${flipped.description || 'no description'}” on ${flipped.entryDate} is this exact amount recorded the other way round. The statement says ${line.amount < 0 ? 'money out' : 'money in'}; the entry says ${flipped.amount < 0 ? 'money out' : 'money in'}.`,
      }
    }

    // 3. Nearly the same money, close by — a fee, a rounding, or a typo.
    const close = near
      .filter(c => c.gap <= windowDays * 2 && Math.sign(c.amount) === Math.sign(line.amount) && nearlySame(c.amount, line.amount))
      .sort((a, b) => Math.abs(Math.abs(a.amount) - Math.abs(line.amount)) - Math.abs(Math.abs(b.amount) - Math.abs(line.amount)))[0]
    if (close) {
      const diff = round2(line.amount - close.amount)
      return {
        ...base,
        kind: 'amount-differs' as const,
        entryId: close.id,
        difference: diff,
        dayGap: close.gap,
        message: `“${close.description || 'no description'}” on ${close.entryDate} is close but not equal — the statement is ${Math.abs(diff)} ${Math.abs(line.amount) > Math.abs(close.amount) ? 'more' : 'less'} than the entry.`,
      }
    }

    // 4. Nothing resembles it. This one really is missing from the books.
    return {
      ...base,
      kind: 'nothing-near' as const,
      message: 'Nothing like this is recorded in the cash book. It looks like a transaction that was never entered.',
    }
  })
}

/* ── Entries recorded twice ──────────────────────────────────────────────── */

export interface DuplicateGroup {
  entryIds: string[]
  amount: number
  message: string
}

/**
 * Unclaimed entries that look like the same transaction entered twice.
 *
 * The other half of "what is in the books but not on the statement". A line
 * matches ONE of a duplicated pair and the twin is left over, so the leftover
 * reads as an unexplained entry when the real story is a double entry. Same
 * amount, within a day or two, is the shape that actually happens — someone
 * records a payment, does not see it, and records it again.
 */
export function flagDuplicateEntries(
  entries: readonly EntryCandidate[],
  withinDays = 2,
): DuplicateGroup[] {
  const free = entries.filter(e => !e.taken)
  const byAmount = new Map<string, EntryCandidate[]>()
  for (const e of free) {
    const key = round2(e.amount).toFixed(2)
    byAmount.set(key, [...(byAmount.get(key) ?? []), e])
  }

  const groups: DuplicateGroup[] = []
  for (const [, sameSize] of byAmount) {
    if (sameSize.length < 2) continue
    const sorted = [...sameSize].sort((a, b) => a.entryDate.localeCompare(b.entryDate))
    let run: EntryCandidate[] = [sorted[0]]
    const flush = () => {
      if (run.length >= 2) {
        groups.push({
          entryIds: run.map(e => e.id),
          amount: round2(run[0].amount),
          message: `${run.length} entries of ${round2(Math.abs(run[0].amount))} within ${days(withinDays)} of each other, none of them on the statement. Recorded twice?`,
        })
      }
      run = []
    }
    for (let i = 1; i < sorted.length; i++) {
      if (daysBetween(sorted[i - 1].entryDate, sorted[i].entryDate) <= withinDays) run.push(sorted[i])
      else { flush(); run = [sorted[i]] }
    }
    flush()
  }
  return groups
}

/* ── Does a bank period add up? ──────────────────────────────────────────── */

/**
 * The bank equivalent of `cycleBalance`, and a stronger check than a card's.
 *
 * A bank statement states the balance it started from and the balance it
 * ended at, so the lines between them are fully constrained: opening plus
 * every movement must BE the closing balance. If it is not, the import is
 * missing a line or read one's direction backwards — and no amount of matching
 * against the cash book would have revealed that, because the fault is in the
 * statement as imported, before the books are consulted at all.
 */
export function periodBalance(
  lines: readonly StatementLine[],
  opening: number | null,
  closing: number | null,
): { movement: number; expectedClosing: number | null; difference: number | null; agrees: boolean } {
  const movement = round2(lines.reduce((sum, l) => sum + l.amount, 0))
  if (opening === null || closing === null) {
    return { movement, expectedClosing: null, difference: null, agrees: false }
  }
  const expectedClosing = round2(opening + movement)
  const difference = round2(expectedClosing - closing)
  return { movement, expectedClosing, difference, agrees: Math.abs(difference) < SAME }
}
