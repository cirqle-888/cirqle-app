/**
 * Social autopilot: the pure decisions, kept apart from the database so they
 * are easy to test. See social.ts for the jobs that use them.
 */
import { dueDateForPublish } from '@/lib/social/plan'

/** A placeholder the monthly template leaves for the daily trend check. */
export const TREND_SLOT = /trend\s*slot/i

/** Day of the month from which next month's drafts are written. */
export const DRAFT_START_DAY = 10

/** Failed attempts per client and month before the autopilot stops retrying. */
export const MAX_DRAFT_ATTEMPTS = 3

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function monthStart(dateISO: string): string {
  return `${dateISO.slice(0, 7)}-01`
}

export function nextMonthStart(dateISO: string): string {
  const y = Number(dateISO.slice(0, 4))
  const m = Number(dateISO.slice(5, 7))
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

export function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function addDays(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export interface PlanItemRow {
  id: string
  calendar_id: string
  scheduled_date: string | null
  title: string | null
  status: string
  request_id: string | null
  task_id?: string | null
}

/**
 * Posts whose designer deadline has come: planned, not yet sent, dated today
 * or later, in an Active plan. Trend slots are held back: they are empty
 * until someone fills them, so they are reported instead of sent.
 */
export function pickDuePosts(items: PlanItemRow[], activeCalendarIds: Set<string>, leadDays: number, today: string) {
  const due: PlanItemRow[] = []
  const emptyTrendSlots: PlanItemRow[] = []
  for (const it of items) {
    if (it.status !== 'planned' || it.request_id || it.task_id) continue
    if (!it.scheduled_date || it.scheduled_date < today) continue
    if (!activeCalendarIds.has(it.calendar_id)) continue
    const deadline = dueDateForPublish(it.scheduled_date, leadDays)
    if (!deadline || deadline > today) continue
    if (TREND_SLOT.test(it.title || '')) emptyTrendSlots.push(it)
    else due.push(it)
  }
  const byDate = (a: PlanItemRow, b: PlanItemRow) => (a.scheduled_date || '').localeCompare(b.scheduled_date || '')
  return { due: due.sort(byDate), emptyTrendSlots: emptyTrendSlots.sort(byDate) }
}

export interface DraftCandidateRow {
  clientId: string
  name: string
  hasCard: boolean
  /** Non-cancelled posts in this month's Active plan. */
  thisMonthItems: number
  /** Next month's plan, when one exists. */
  nextPlan: { status: string; items: number } | null
  /** An AI draft for next month was already saved. */
  drafted: boolean
  failedAttempts: number
  /** A failed attempt was already made today. */
  triedToday: boolean
}

/**
 * Which clients get an AI draft for next month, in order. A client
 * qualifies when it is a working social client (an Active plan with posts
 * this month and a Client Card) and next month is still blank: no plan, or
 * an empty Draft plan. An Active plan someone opened is left alone.
 */
export function pickDraftCandidates(rows: DraftCandidateRow[]): DraftCandidateRow[] {
  return rows
    .filter(r => r.hasCard && r.thisMonthItems > 0 && !r.drafted && !r.triedToday && r.failedAttempts < MAX_DRAFT_ATTEMPTS)
    .filter(r => !r.nextPlan || (r.nextPlan.status === 'draft' && r.nextPlan.items === 0))
    .sort((a, b) => a.failedAttempts - b.failedAttempts || a.name.localeCompare(b.name))
}

export function draftsDue(today: string, startDay = DRAFT_START_DAY): boolean {
  return Number(today.slice(8, 10)) >= startDay
}

/** The month in two halves, so each AI answer fits the free plan's token limit. */
export function monthHalves(month: string): { from: string; to: string }[] {
  const last = daysInMonth(month)
  const ym = month.slice(0, 7)
  return [
    { from: `${ym}-01`, to: `${ym}-15` },
    { from: `${ym}-16`, to: `${ym}-${String(last).padStart(2, '0')}` },
  ]
}

/** Rough token count for planning a request; Groq counts real tokens. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/**
 * How many tokens the answer may use. Groq's free plan refuses a request
 * whose prompt plus answer budget exceeds the per-minute limit (8,000 for
 * gpt-oss-120b), so the budget is what is left after the prompt.
 */
export function answerBudget(promptTokens: number, perMinuteLimit = 8000): number {
  return Math.max(1500, Math.min(5200, perMinuteLimit - promptTokens - 300))
}

/**
 * Added after the monthly template when the app's own AI runs it. The
 * template is written for chat AIs that can search the web; this run cannot,
 * and it plans half a month at a time.
 */
export function automatedRunNote(half: { from: string; to: string }, month: string, alreadyThisMonth: string[]): string {
  const lines = [
    'AUTOMATED RUN. Read this before following the instructions above:',
    '- You cannot search the web or open links in this run. Skip those steps and work from the CLIENT CARD and what you know.',
    `- Plan ONLY the posts dated ${half.from} to ${half.to}. Another run plans the rest of ${monthLabel(month)}.`,
    '- A festival or special day whose date changes every year gets a date only if you are sure of it for this year; otherwise add "(check date)" at the end of Theme.',
    '- References: search phrases only, never a link.',
    '- Keep each post compact: Caption up to 60 words; Visual direction and AI prompt up to 60 words each.',
  ]
  if (alreadyThisMonth.length) {
    lines.push(`- Posts this client already has this month (do not repeat these ideas): ${alreadyThisMonth.slice(0, 25).join('; ')}`)
  }
  lines.push('- Output the ### POST blocks only, exactly in the form above.')
  return lines.join('\n')
}
