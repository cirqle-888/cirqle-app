/**
 * Recurring-expense schedule — pure date math, no Supabase.
 *
 * Mirrors the just-in-time rule the recurring-TASK cron already uses: an
 * occurrence is posted only once its own due date has arrived, never ahead of
 * time. If the cron is down for a while, the missed occurrences are posted on
 * their OWN dates (not bunched onto today), capped so a long outage can't
 * flood the cashbook on the first run back.
 *
 * Period keys ('2026-07' monthly, '2026' yearly) are what make posting
 * idempotent: the cron writes them into the cashbook entry's `reference`, then
 * skips any period it already finds there.
 */

export interface RecurringRule {
  id: string
  /** YYYY-MM-DD — no occurrence before this date. */
  start_date: string
  /** YYYY-MM-DD inclusive, or null for open-ended. */
  end_date: string | null
  /** 1–28, so every month has the day (no clamping rules to reason about). */
  day_of_month: number
  frequency: 'monthly' | 'yearly'
}

export interface DueOccurrence {
  /** Idempotency key: '2026-07' (monthly) or '2026' (yearly). */
  period: string
  /** The date the entry is posted under — its own due date, not today. */
  postDate: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Period key for a due date under this rule's frequency. */
export function periodKey(frequency: 'monthly' | 'yearly', year: number, month: number): string {
  return frequency === 'yearly' ? String(year) : `${year}-${pad(month)}`
}

/**
 * Every occurrence that is due on or before `today` and not yet posted.
 *
 * @param existingPeriods period keys already present in the cashbook
 * @param cap  max occurrences returned for this rule in one run
 */
export function duePeriods(
  rule: RecurringRule,
  today: string,
  existingPeriods: Iterable<string> = [],
  cap = 12,
): DueOccurrence[] {
  const seen = new Set(existingPeriods)
  const out: DueOccurrence[] = []

  const [sy, sm] = rule.start_date.split('-').map(Number)
  if (!Number.isInteger(sy) || !Number.isInteger(sm)) return out

  // Yearly rules repeat on the start month; monthly rules on every month.
  const step = rule.frequency === 'yearly' ? 12 : 1
  const day = Math.min(Math.max(rule.day_of_month || 1, 1), 28)

  let year = sy
  let month = sm

  // Bounded walk: the cap ends it in practice, this is the runaway backstop.
  for (let i = 0; i < 600; i++) {
    const postDate = `${year}-${pad(month)}-${pad(day)}`
    if (postDate > today) break
    if (rule.end_date && postDate > rule.end_date) break
    // The rule's own start_date may fall after its first period's nominal day
    // (e.g. start 2026-07-20 with day_of_month 1) — don't back-date that one.
    if (postDate >= rule.start_date) {
      const period = periodKey(rule.frequency, year, month)
      if (!seen.has(period)) {
        out.push({ period, postDate })
        seen.add(period)
        if (out.length >= cap) break
      }
    }
    month += step
    while (month > 12) { month -= 12; year += 1 }
  }

  return out
}

/** Next date this rule will post on after `today` — for "next due" in the UI. */
export function nextDueDate(rule: RecurringRule, today: string): string | null {
  const [sy, sm] = rule.start_date.split('-').map(Number)
  if (!Number.isInteger(sy) || !Number.isInteger(sm)) return null
  const step = rule.frequency === 'yearly' ? 12 : 1
  const day = Math.min(Math.max(rule.day_of_month || 1, 1), 28)
  let year = sy
  let month = sm
  for (let i = 0; i < 600; i++) {
    const d = `${year}-${pad(month)}-${pad(day)}`
    if (d > today && d >= rule.start_date) {
      if (rule.end_date && d > rule.end_date) return null
      return d
    }
    month += step
    while (month > 12) { month -= 12; year += 1 }
  }
  return null
}
