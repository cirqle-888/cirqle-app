/**
 * Owner alerts — the rules behind the daily alerts and the weekly owner check.
 *
 * Why this exists: until now, every loose end (an invoice nobody sent, an
 * invoice nobody chased, a client who went quiet, a request past its date)
 * waited for the owner to notice it. The daily alert fired once per invoice,
 * ever. These rules let the system notice instead, and say so in one place.
 *
 * Used by BOTH the business-alerts cron and the Business Health page, so the
 * alert and the page can never disagree.
 *
 * Pure and dependency-free apart from date arithmetic. Every date is a
 * `YYYY-MM-DD` string on the India business calendar (see
 * lib/utils/local-date.ts); no Date objects cross the boundary, so the
 * server's timezone cannot shift a day.
 */

import { addDaysISO } from '@/lib/utils/local-date'

// ── Dates ─────────────────────────────────────────────────────────────────

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/

function dayNumber(iso: string | null | undefined): number | null {
  const m = ISO_RE.exec((iso || '').trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
  // Noon UTC, floored: day 0 is 1970-01-01, whatever the host timezone.
  return Number.isNaN(t) ? null : Math.floor(t / 86_400_000)
}

/** Whole days from `fromISO` to `toISO` (positive when `toISO` is later). */
export function daysBetween(fromISO: string | null | undefined, toISO: string | null | undefined): number | null {
  const a = dayNumber(fromISO)
  const b = dayNumber(toISO)
  return a === null || b === null ? null : b - a
}

/** The calendar day part of an ISO date or timestamp. */
function datePart(iso: string | null | undefined): string | null {
  const m = ISO_RE.exec((iso || '').trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** True when the date falls on a Monday. */
export function isMondayISO(iso: string): boolean {
  const n = dayNumber(iso)
  // Day 0 of the epoch (1970-01-01) was a Thursday.
  return n !== null && ((n % 7) + 7) % 7 === 4
}

// ── Inputs ────────────────────────────────────────────────────────────────

export interface InvoiceLite {
  id: string
  invoice_number: string
  status: string
  issue_date: string | null
  due_date: string | null
  total_inr: number
  paid_inr: number
  client_id: string | null
  client_name: string | null
}

export interface LatestFollowup {
  promised_date: string | null
  next_followup_date: string | null
  created_at: string
}

export interface TaskLite {
  client_id: string | null
  task_date: string
  value_inr: number
}

export interface ClientLite {
  id: string
  name: string
  is_active: boolean
}

export interface RequestLite {
  id: string
  ref_no: number
  title: string
  status: string
  due_date: string | null
  client_name: string | null
}

export interface CronRunLite {
  cron_name: string
  ran_at: string
  ok: boolean
  error: string | null
}

const SENT_STATUSES = new Set(['sent', 'partial', 'overdue'])
const DRAFT_STATUSES = new Set(['draft', 'reviewed'])

export function outstandingInr(inv: InvoiceLite): number {
  return Math.max(0, (inv.total_inr || 0) - (inv.paid_inr || 0))
}

// ── Overdue invoices ──────────────────────────────────────────────────────

/**
 * The date payment was due.
 *
 * The invoice's own due date, else net-30 from issue — the same default the
 * Follow-ups page uses. A due date BEFORE the issue date is a data-entry slip
 * (see `invoiceRecordIssues`); trusting it would call a new invoice months
 * overdue, so net-30 from issue is used instead.
 */
export function effectiveDueISO(inv: Pick<InvoiceLite, 'issue_date' | 'due_date'>): string | null {
  const issue = datePart(inv.issue_date)
  const due = datePart(inv.due_date)
  if (due && issue && due < issue) return addDaysISO(issue, 30) || null
  if (due) return due
  if (issue) return addDaysISO(issue, 30) || null
  return null
}

/** Days past the effective due date; 0 or negative when not yet due. */
export function daysOverdue(inv: InvoiceLite, today: string): number | null {
  return daysBetween(effectiveDueISO(inv), today)
}

/** Escalation points, in days overdue. The 30-day notice is the owner's. */
export const ESCALATION_STAGES = [7, 14, 30] as const
export type EscalationStage = 0 | (typeof ESCALATION_STAGES)[number]

/** The highest escalation point an invoice has reached. */
export function escalationStage(days: number | null): EscalationStage {
  if (days === null) return 0
  let reached: EscalationStage = 0
  for (const s of ESCALATION_STAGES) if (days >= s) reached = s
  return reached
}

/** Someone is on it: the client promised a date, or a chase is scheduled, today or later. */
export function isBeingHandled(latest: LatestFollowup | undefined, today: string): boolean {
  if (!latest) return false
  const promised = datePart(latest.promised_date)
  const next = datePart(latest.next_followup_date)
  return (!!promised && promised >= today) || (!!next && next >= today)
}

/**
 * Which escalation notice to send today, or 0 for none.
 *
 * Only the highest stage reached, and only when it is higher than any stage
 * already sent for this invoice — so an invoice first noticed at 40 days gets
 * one 30-day notice, not three. The 7 and 14-day notices hold back while
 * someone is visibly handling the invoice; the 30-day notice always goes out,
 * because by then the owner should know regardless.
 */
export function escalationToSend(
  inv: InvoiceLite,
  latest: LatestFollowup | undefined,
  alreadySent: number,
  today: string,
): EscalationStage {
  if (!SENT_STATUSES.has(inv.status)) return 0
  if (outstandingInr(inv) <= 0) return 0
  const stage = escalationStage(daysOverdue(inv, today))
  if (stage === 0 || stage <= alreadySent) return 0
  if (stage < 30 && isBeingHandled(latest, today)) return 0
  return stage
}

export const STAGE_KEY_PREFIX = 'invoice_overdue_stage:'

export function stageKey(invoiceId: string, stage: EscalationStage): string {
  return `${STAGE_KEY_PREFIX}${invoiceId}:${stage}`
}

export function parseStageKey(sourceKey: string | null | undefined): { invoiceId: string; stage: number } | null {
  if (!sourceKey || !sourceKey.startsWith(STAGE_KEY_PREFIX)) return null
  const rest = sourceKey.slice(STAGE_KEY_PREFIX.length)
  const at = rest.lastIndexOf(':')
  if (at <= 0) return null
  const stage = Number(rest.slice(at + 1))
  return Number.isFinite(stage) ? { invoiceId: rest.slice(0, at), stage } : null
}

/** Highest stage already sent per invoice, from existing notification keys. */
export function highestSentStages(sourceKeys: readonly (string | null)[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const k of sourceKeys) {
    const p = parseStageKey(k)
    if (p && p.stage > (m.get(p.invoiceId) ?? 0)) m.set(p.invoiceId, p.stage)
  }
  return m
}

export interface OverdueItem {
  invoiceId: string
  invoiceNumber: string
  clientName: string
  daysOverdue: number
  outstandingInr: number
}

export interface OverdueSummary {
  buckets: Record<'1-7' | '8-14' | '15-30' | '30+', { count: number; amountInr: number }>
  totalCount: number
  totalInr: number
  /** A promised payment date has passed and the invoice is still unpaid. */
  promisesMissed: number
  /** Overdue, and nobody has logged contact in the last 7 days. */
  noRecentContact: number
  /** Largest first. */
  top: OverdueItem[]
}

export function overdueSummary(
  invoices: readonly InvoiceLite[],
  latest: ReadonlyMap<string, LatestFollowup>,
  today: string,
  topN = 5,
): OverdueSummary {
  const buckets: OverdueSummary['buckets'] = {
    '1-7': { count: 0, amountInr: 0 },
    '8-14': { count: 0, amountInr: 0 },
    '15-30': { count: 0, amountInr: 0 },
    '30+': { count: 0, amountInr: 0 },
  }
  const items: OverdueItem[] = []
  let promisesMissed = 0
  let noRecentContact = 0

  for (const inv of invoices) {
    if (!SENT_STATUSES.has(inv.status)) continue
    const owed = outstandingInr(inv)
    if (owed <= 0) continue
    const l = latest.get(inv.id)
    const promised = datePart(l?.promised_date)
    if (promised && promised < today) promisesMissed++

    const d = daysOverdue(inv, today)
    if (d === null || d <= 0) continue
    const key = d <= 7 ? '1-7' : d <= 14 ? '8-14' : d <= 30 ? '15-30' : '30+'
    buckets[key].count++
    buckets[key].amountInr += owed
    const lastContact = daysBetween(datePart(l?.created_at), today)
    if (lastContact === null || lastContact > 7) noRecentContact++
    items.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      clientName: inv.client_name || 'Unknown client',
      daysOverdue: d,
      outstandingInr: owed,
    })
  }

  items.sort((a, b) => b.outstandingInr - a.outstandingInr || b.daysOverdue - a.daysOverdue)
  return {
    buckets,
    totalCount: items.length,
    totalInr: items.reduce((s, i) => s + i.outstandingInr, 0),
    promisesMissed,
    noRecentContact,
    top: items.slice(0, topN),
  }
}

// ── Invoices not yet sent ─────────────────────────────────────────────────

/** A draft dated this many days ago or more should already be with the client. */
export const UNSENT_AFTER_DAYS = 3

export interface UnsentItem {
  invoiceId: string
  invoiceNumber: string
  clientName: string
  daysWaiting: number
  totalInr: number
}

/**
 * Draft or reviewed invoices whose date has passed by `UNSENT_AFTER_DAYS`.
 *
 * Drafts dated in the future are normal (the monthly auto-draft collects next
 * month's work in advance) and are ignored.
 */
export function unsentInvoices(invoices: readonly InvoiceLite[], today: string): UnsentItem[] {
  const out: UnsentItem[] = []
  for (const inv of invoices) {
    if (!DRAFT_STATUSES.has(inv.status)) continue
    const waiting = daysBetween(datePart(inv.issue_date), today)
    if (waiting === null || waiting < UNSENT_AFTER_DAYS) continue
    out.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      clientName: inv.client_name || 'Unknown client',
      daysWaiting: waiting,
      totalInr: inv.total_inr || 0,
    })
  }
  return out.sort((a, b) => b.daysWaiting - a.daysWaiting || b.totalInr - a.totalInr)
}

// ── Clients going quiet or slowing down ───────────────────────────────────

/** Look-back for deciding who counts as a regular client. */
export const CLIENT_WINDOW_DAYS = 180
/** A regular client with no job for this long is "quiet". */
export const QUIET_AFTER_DAYS = 21
/** Months with work, inside the window, to count as regular. */
export const REGULAR_MIN_MONTHS = 3

export interface QuietClient {
  clientId: string
  clientName: string
  lastTaskDate: string
  daysSilent: number
  activeMonths: number
  monthlyAvgInr: number
}

export interface FallingClient {
  clientId: string
  clientName: string
  recentMonthlyInr: number
  priorMonthlyInr: number
  dropPct: number
}

interface ClientStats {
  months: Set<string>
  total: number
  last: string
  recent: number
  prior: number
}

function clientStats(tasks: readonly TaskLite[], today: string): Map<string, ClientStats> {
  const stats = new Map<string, ClientStats>()
  for (const t of tasks) {
    if (!t.client_id) continue
    const date = datePart(t.task_date)
    const age = daysBetween(date, today)
    if (!date || age === null || age < 0 || age >= CLIENT_WINDOW_DAYS) continue
    let s = stats.get(t.client_id)
    if (!s) { s = { months: new Set(), total: 0, last: date, recent: 0, prior: 0 }; stats.set(t.client_id, s) }
    const v = Number(t.value_inr) || 0
    s.months.add(date.slice(0, 7))
    s.total += v
    if (date > s.last) s.last = date
    if (age < 60) s.recent += v
    else s.prior += v
  }
  return stats
}

/** Regular clients (work in 3+ months of the last 6) with no job for 21+ days. Most valuable first. */
export function quietClients(clients: readonly ClientLite[], tasks: readonly TaskLite[], today: string): QuietClient[] {
  const stats = clientStats(tasks, today)
  const out: QuietClient[] = []
  for (const c of clients) {
    if (!c.is_active) continue
    const s = stats.get(c.id)
    if (!s || s.months.size < REGULAR_MIN_MONTHS) continue
    const silent = daysBetween(s.last, today) ?? 0
    if (silent < QUIET_AFTER_DAYS) continue
    out.push({
      clientId: c.id,
      clientName: c.name,
      lastTaskDate: s.last,
      daysSilent: silent,
      activeMonths: s.months.size,
      monthlyAvgInr: Math.round(s.total / s.months.size),
    })
  }
  return out.sort((a, b) => b.monthlyAvgInr - a.monthlyAvgInr)
}

/** Below this prior monthly value a drop is noise, not a signal. */
export const FALLING_MIN_PRIOR_INR = 1500

/**
 * Regular clients spending less than half their usual: the last two months'
 * monthly average against the four months before. Quiet clients are left
 * out — they are already reported.
 */
export function fallingClients(
  clients: readonly ClientLite[],
  tasks: readonly TaskLite[],
  today: string,
  exclude: ReadonlySet<string> = new Set(),
): FallingClient[] {
  const stats = clientStats(tasks, today)
  const out: FallingClient[] = []
  for (const c of clients) {
    if (!c.is_active || exclude.has(c.id)) continue
    const s = stats.get(c.id)
    // A single large job is not a spending pattern; only regular clients count.
    if (!s || s.months.size < REGULAR_MIN_MONTHS) continue
    const recentMonthly = s.recent / 2
    const priorMonthly = s.prior / 4
    if (priorMonthly < FALLING_MIN_PRIOR_INR) continue
    if (recentMonthly >= priorMonthly * 0.5) continue
    out.push({
      clientId: c.id,
      clientName: c.name,
      recentMonthlyInr: Math.round(recentMonthly),
      priorMonthlyInr: Math.round(priorMonthly),
      dropPct: Math.round((1 - recentMonthly / priorMonthly) * 100),
    })
  }
  return out.sort((a, b) => b.priorMonthlyInr - b.recentMonthlyInr - (a.priorMonthlyInr - a.recentMonthlyInr))
}

// ── Requests past their date ──────────────────────────────────────────────

const FINISHED_REQUEST = new Set(['completed', 'delivered', 'cancelled', 'closed', 'promoted', 'rejected', 'archived'])

export interface OverdueRequest extends RequestLite {
  daysLate: number
}

export function overdueRequests(requests: readonly RequestLite[], today: string): OverdueRequest[] {
  const out: OverdueRequest[] = []
  for (const r of requests) {
    if (FINISHED_REQUEST.has(r.status)) continue
    const late = daysBetween(datePart(r.due_date), today)
    if (late === null || late <= 0) continue
    out.push({ ...r, daysLate: late })
  }
  return out.sort((a, b) => b.daysLate - a.daysLate)
}

// ── Records that look wrong ───────────────────────────────────────────────

export interface RecordIssue {
  kind: 'due_before_issue' | 'sent_future_dated'
  invoiceId: string
  invoiceNumber: string
  detail: string
}

export function invoiceRecordIssues(invoices: readonly InvoiceLite[], today: string): RecordIssue[] {
  const out: RecordIssue[] = []
  for (const inv of invoices) {
    if (inv.status === 'cancelled') continue
    const issue = datePart(inv.issue_date)
    const due = datePart(inv.due_date)
    if (issue && due && due < issue) {
      out.push({ kind: 'due_before_issue', invoiceId: inv.id, invoiceNumber: inv.invoice_number, detail: `Due ${due} is before the issue date ${issue}` })
    }
    if (SENT_STATUSES.has(inv.status) && issue && issue > today) {
      out.push({ kind: 'sent_future_dated', invoiceId: inv.id, invoiceNumber: inv.invoice_number, detail: `Marked sent but dated ${issue}` })
    }
  }
  return out
}

// ── Automations that failed ───────────────────────────────────────────────

export interface AutomationFailure {
  name: string
  failedRuns: number
  lastError: string | null
  lastFailedAt: string
}

/**
 * Scheduled jobs whose MOST RECENT run failed. A job that failed on Tuesday
 * and succeeded on Wednesday has recovered and is not reported.
 */
export function automationFailures(runs: readonly CronRunLite[]): AutomationFailure[] {
  const byName = new Map<string, CronRunLite[]>()
  for (const r of runs) {
    const list = byName.get(r.cron_name) ?? []
    list.push(r)
    byName.set(r.cron_name, list)
  }
  const out: AutomationFailure[] = []
  for (const [name, list] of byName) {
    list.sort((a, b) => (a.ran_at < b.ran_at ? 1 : -1))
    if (list[0].ok) continue
    out.push({
      name,
      failedRuns: list.filter(r => !r.ok).length,
      lastError: list[0].error,
      lastFailedAt: list[0].ran_at,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ── The owner check ───────────────────────────────────────────────────────

export interface OwnerCheckInput {
  invoices: InvoiceLite[]
  latestFollowups: Map<string, LatestFollowup>
  tasks: TaskLite[]
  clients: ClientLite[]
  requests: RequestLite[]
  cashbook: { uncategorised: number; unreviewed: number }
  cronRuns: CronRunLite[]
}

export interface OwnerCheck {
  today: string
  unsent: { count: number; totalInr: number; items: UnsentItem[] }
  overdue: OverdueSummary
  quiet: QuietClient[]
  falling: FallingClient[]
  requestsOverdue: OverdueRequest[]
  cashbook: { uncategorised: number; unreviewed: number }
  recordIssues: RecordIssue[]
  automationFailures: AutomationFailure[]
  /** How many separate things need a person. 0 = a quiet week. */
  attentionCount: number
}

export function buildOwnerCheck(input: OwnerCheckInput, today: string): OwnerCheck {
  const unsentItems = unsentInvoices(input.invoices, today)
  const overdue = overdueSummary(input.invoices, input.latestFollowups, today)
  const quiet = quietClients(input.clients, input.tasks, today)
  const falling = fallingClients(input.clients, input.tasks, today, new Set(quiet.map(q => q.clientId)))
  const requestsOverdue = overdueRequests(input.requests, today)
  const recordIssues = invoiceRecordIssues(input.invoices, today)
  const failures = automationFailures(input.cronRuns)

  const attentionCount =
    unsentItems.length +
    overdue.buckets['15-30'].count + overdue.buckets['30+'].count +
    overdue.promisesMissed +
    quiet.length + falling.length +
    requestsOverdue.length +
    (input.cashbook.uncategorised > 0 ? 1 : 0) +
    recordIssues.length +
    failures.length

  return {
    today,
    unsent: { count: unsentItems.length, totalInr: unsentItems.reduce((s, i) => s + i.totalInr, 0), items: unsentItems },
    overdue,
    quiet,
    falling,
    requestsOverdue,
    cashbook: input.cashbook,
    recordIssues,
    automationFailures: failures,
    attentionCount,
  }
}

function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}

/**
 * One short line per non-empty section, in priority order — the body of the
 * weekly notification and email. Empty sections are left out, so a good week
 * reads as a short message rather than a list of zeros.
 */
export function ownerCheckLines(check: OwnerCheck, showAmounts = true): string[] {
  const money = (n: number) => (showAmounts ? ` (${inr(n)})` : '')
  const lines: string[] = []
  if (check.unsent.count) lines.push(`${check.unsent.count} invoice${check.unsent.count === 1 ? '' : 's'} not sent yet${money(check.unsent.totalInr)}`)
  const late = check.overdue.buckets['15-30'].count + check.overdue.buckets['30+'].count
  if (check.overdue.totalCount) {
    lines.push(`${check.overdue.totalCount} overdue${money(check.overdue.totalInr)}, ${late} more than 14 days`)
  }
  if (check.overdue.promisesMissed) lines.push(`${check.overdue.promisesMissed} payment promise${check.overdue.promisesMissed === 1 ? '' : 's'} missed`)
  if (check.overdue.noRecentContact) lines.push(`${check.overdue.noRecentContact} overdue with no contact in 7 days`)
  if (check.quiet.length) lines.push(`${check.quiet.length} regular client${check.quiet.length === 1 ? '' : 's'} quiet for 3+ weeks`)
  if (check.falling.length) lines.push(`${check.falling.length} client${check.falling.length === 1 ? '' : 's'} spending less than half their usual`)
  if (check.requestsOverdue.length) lines.push(`${check.requestsOverdue.length} request${check.requestsOverdue.length === 1 ? '' : 's'} past their due date`)
  if (check.cashbook.uncategorised) lines.push(`${check.cashbook.uncategorised} cash book entr${check.cashbook.uncategorised === 1 ? 'y' : 'ies'} without a category`)
  if (check.recordIssues.length) lines.push(`${check.recordIssues.length} invoice date${check.recordIssues.length === 1 ? '' : 's'} to correct`)
  if (check.automationFailures.length) lines.push(`${check.automationFailures.length} automation${check.automationFailures.length === 1 ? '' : 's'} failing: ${check.automationFailures.map(f => f.name).join(', ')}`)
  return lines
}
