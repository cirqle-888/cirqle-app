/**
 * Client payment-reliability + business-value scoring — pure, dependency-free
 * so it's testable and reusable from the Client Ranking report.
 *
 * Three views, computed together since the Strategic Score needs both halves:
 *  - Payment Reliability: how well a client pays (lateness, broken promises,
 *    overdue frequency, how much chasing they need).
 *  - Business Value: how much the relationship is worth (revenue, completed
 *    work, recency, growth trend).
 *  - Strategic Score = 60% value + 40% reliability → a classification label.
 *
 * All formulas are heuristic and intentionally documented inline so the
 * weights/thresholds can be tuned later without re-deriving the logic.
 */

export interface ScoringInvoice {
  id:               string
  client_id:        string
  status:           string   // draft | reviewed | sent | partial | overdue | paid | cancelled | bad_debt
  issue_date:       string | null
  due_date:         string | null
  total_amount_inr: number
  paid_amount_inr:  number
}
export interface ScoringPayment { invoice_id: string; payment_date: string }
export interface ScoringAllocation { invoice_id: string; entry_date: string | null }
export interface ScoringFollowup { invoice_id: string; created_at: string; promised_date: string | null }
export interface ScoringTask { client_id: string; status: string; task_date: string | null }
export interface ScoringClient { id: string; name: string }

export interface PaymentReliability {
  avgDaysToPay:     number | null  // avg(paid date − issue date) across paid invoices
  avgDaysLate:      number | null  // avg(paid date − due date); negative = paid early
  promiseKeptRate:  number | null  // 0–100, % of past-due promises that were honoured
  promisesTracked:  number
  overdueRate:      number         // 0–100, % of live invoices that are/were overdue
  outstandingInr:   number         // current unpaid balance
  followUpEffort:   number         // avg follow-ups needed per invoice that needed any
  score:            number         // 0–100 composite
}
export interface BusinessValue {
  totalRevenueInr:    number       // lifetime billed (non-draft, non-cancelled)
  invoiceCount:       number
  taskCount:          number       // lifetime completed/billable tasks
  recentActivityDays: number | null
  revenueTrendPct:    number | null // last 90d vs prior 90d, % change
  score:              number        // 0–100 composite (cohort-normalized)
}
export type ClientClass = 'Strategic Client' | 'Growth Client' | 'High Value Risk' | 'Reliable Small Client' | 'Watchlist Client'

export interface ClientScore {
  clientId:       string
  clientName:     string
  reliability:    PaymentReliability
  value:          BusinessValue
  strategicScore: number
  classification: ClientClass
}

import { recognisedRevenue } from '@/lib/finance/invoice-revenue'
import { toISODate } from '@/lib/utils/local-date'

const LIVE_STATUSES = ['sent', 'partial', 'overdue']            // currently with the client, unpaid
// Counts toward revenue/frequency. `bad_debt` belongs here: the work WAS billed,
// and a client who was written off should show the revenue they actually paid
// (usually nothing) rather than vanishing from the ranking as if they never
// traded with us. recognisedRevenue() books only the recovered part.
const BILLED_STATUSES = ['sent', 'partial', 'overdue', 'paid', 'bad_debt']
const day = 86400000

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / day)
}
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }

export function computeClientScores(
  clients:     ScoringClient[],
  invoices:    ScoringInvoice[],
  payments:    ScoringPayment[],
  allocations: ScoringAllocation[],
  followups:   ScoringFollowup[],
  tasks:       ScoringTask[],
  today:       Date = new Date(),
): ClientScore[] {
  const todayIso =toISODate( today)

  // ── Index everything by invoice / client for O(1) lookups ──────────────
  const lastPaymentByInvoice = new Map<string, string>()
  for (const p of payments) {
    const cur = lastPaymentByInvoice.get(p.invoice_id)
    if (!cur || p.payment_date > cur) lastPaymentByInvoice.set(p.invoice_id, p.payment_date)
  }
  const lastAllocByInvoice = new Map<string, string>()
  for (const a of allocations) {
    if (!a.entry_date) continue
    const cur = lastAllocByInvoice.get(a.invoice_id)
    if (!cur || a.entry_date > cur) lastAllocByInvoice.set(a.invoice_id, a.entry_date)
  }
  /** Best-guess date a now-`paid` invoice actually became fully paid. */
  function completionDate(invoiceId: string): string | null {
    const p = lastPaymentByInvoice.get(invoiceId)
    const a = lastAllocByInvoice.get(invoiceId)
    if (p && a) return p > a ? p : a
    return p || a || null
  }

  const latestFollowupByInvoice = new Map<string, ScoringFollowup>()
  for (const f of followups) {
    const cur = latestFollowupByInvoice.get(f.invoice_id)
    if (!cur || f.created_at > cur.created_at) latestFollowupByInvoice.set(f.invoice_id, f)
  }
  const followupCountByInvoice = new Map<string, number>()
  for (const f of followups) followupCountByInvoice.set(f.invoice_id, (followupCountByInvoice.get(f.invoice_id) ?? 0) + 1)

  const invoicesByClient = new Map<string, ScoringInvoice[]>()
  for (const inv of invoices) {
    const arr = invoicesByClient.get(inv.client_id) ?? []
    arr.push(inv)
    invoicesByClient.set(inv.client_id, arr)
  }
  const tasksByClient = new Map<string, ScoringTask[]>()
  for (const t of tasks) {
    const arr = tasksByClient.get(t.client_id) ?? []
    arr.push(t)
    tasksByClient.set(t.client_id, arr)
  }

  // ── Pass 1: raw per-client metrics ──────────────────────────────────────
  interface Raw { clientId: string; clientName: string; reliability: PaymentReliability; value: Omit<BusinessValue, 'score'> }
  const raw: Raw[] = clients.map(c => {
    const invs = invoicesByClient.get(c.id) ?? []
    const billed = invs.filter(i => BILLED_STATUSES.includes(i.status))
    const live = invs.filter(i => LIVE_STATUSES.includes(i.status))

    // Payment reliability — lateness, on paid invoices only.
    const daysToPay: number[] = []
    const daysLate: number[] = []
    for (const inv of invs.filter(i => i.status === 'paid')) {
      const done = completionDate(inv.id)
      if (!done) continue
      if (inv.issue_date) daysToPay.push(daysBetween(inv.issue_date, done))
      if (inv.due_date) daysLate.push(daysBetween(inv.due_date, done))
    }
    const avgDaysToPay = daysToPay.length ? Math.round(daysToPay.reduce((s, n) => s + n, 0) / daysToPay.length) : null
    const avgDaysLate  = daysLate.length  ? Math.round(daysLate.reduce((s, n) => s + n, 0) / daysLate.length)  : null

    // Promise-keeping — latest follow-up per invoice, only ones with a past promised_date.
    let kept = 0, missed = 0
    for (const inv of invs) {
      const f = latestFollowupByInvoice.get(inv.id)
      if (!f?.promised_date || f.promised_date >= todayIso) continue
      if (inv.status === 'paid') kept++; else missed++
    }
    const promisesTracked = kept + missed
    const promiseKeptRate = promisesTracked ? Math.round((kept / promisesTracked) * 100) : null

    // Overdue frequency — among ever-sent invoices, how many are/were overdue.
    let overdueCount = 0
    for (const inv of billed) {
      if (inv.status === 'overdue') { overdueCount++; continue }
      if (inv.status === 'paid') {
        const done = completionDate(inv.id)
        if (done && inv.due_date && done > inv.due_date) overdueCount++
        continue
      }
      if (LIVE_STATUSES.includes(inv.status) && inv.due_date && inv.due_date < todayIso) overdueCount++
    }
    const overdueRate = billed.length ? Math.round((overdueCount / billed.length) * 100) : 0

    const outstandingInr = live.reduce((s, i) => s + Math.max(0, (i.total_amount_inr ?? 0) - (i.paid_amount_inr ?? 0)), 0)

    // Follow-up effort — avg log entries per invoice, among invoices that needed at least one.
    const chasedInvoices = invs.filter(i => (followupCountByInvoice.get(i.id) ?? 0) > 0)
    const followUpEffort = chasedInvoices.length
      ? Math.round((chasedInvoices.reduce((s, i) => s + (followupCountByInvoice.get(i.id) ?? 0), 0) / chasedInvoices.length) * 10) / 10
      : 0

    // Composite reliability score (0–100). Neutral defaults when there's no
    // history yet, so new clients aren't unfairly penalized.
    const latenessComponent = avgDaysLate == null ? 70 : clamp(100 - (avgDaysLate / 60) * 100, 0, 100)
    const promiseComponent  = promiseKeptRate == null ? 70 : promiseKeptRate
    const overdueComponent  = 100 - overdueRate
    const effortComponent   = clamp(100 - followUpEffort * 25, 0, 100)
    const reliabilityScore  = Math.round(0.30 * latenessComponent + 0.30 * promiseComponent + 0.25 * overdueComponent + 0.15 * effortComponent)

    // Business value raw figures.
    const totalRevenueInr = billed.reduce((s, i) => s + recognisedRevenue(i), 0)
    const invoiceCount = billed.length
    const clientTasks = (tasksByClient.get(c.id) ?? []).filter(t => ['done', 'invoiced', 'paid'].includes(t.status))
    const taskCount = clientTasks.length

    const lastTaskDate = clientTasks.reduce<string | null>((m, t) => (t.task_date && (!m || t.task_date > m) ? t.task_date : m), null)
    const lastInvoiceDate = billed.reduce<string | null>((m, i) => (i.issue_date && (!m || i.issue_date > m) ? i.issue_date : m), null)
    const lastActivity = [lastTaskDate, lastInvoiceDate].filter(Boolean).sort().pop() || null
    const recentActivityDays = lastActivity ? daysBetween(lastActivity, todayIso) : null

    const cutoff90 =toISODate( new Date(today.getTime() - 90 * day))
    const cutoff180 =toISODate( new Date(today.getTime() - 180 * day))
    const recentRevenue = billed.filter(i => i.issue_date && i.issue_date >= cutoff90).reduce((s, i) => s + recognisedRevenue(i), 0)
    const priorRevenue = billed.filter(i => i.issue_date && i.issue_date >= cutoff180 && i.issue_date < cutoff90).reduce((s, i) => s + recognisedRevenue(i), 0)
    const revenueTrendPct = priorRevenue > 0
      ? Math.round(((recentRevenue - priorRevenue) / priorRevenue) * 100)
      : (recentRevenue > 0 ? 100 : null)

    return {
      clientId: c.id, clientName: c.name,
      reliability: {
        avgDaysToPay, avgDaysLate, promiseKeptRate, promisesTracked,
        overdueRate, outstandingInr, followUpEffort, score: reliabilityScore,
      },
      value: { totalRevenueInr, invoiceCount, taskCount, recentActivityDays, revenueTrendPct },
    }
  })

  // ── Pass 2: normalize business value against the cohort (percentile-ish) ──
  const maxRevenue = Math.max(1, ...raw.map(r => r.value.totalRevenueInr))
  const maxTasks   = Math.max(1, ...raw.map(r => r.value.taskCount))

  return raw.map(r => {
    const revenueNorm = clamp(r.value.totalRevenueInr / maxRevenue, 0, 1)
    const taskNorm     = clamp(r.value.taskCount / maxTasks, 0, 1)
    const recencyNorm  = r.value.recentActivityDays == null ? 0 : clamp(1 - r.value.recentActivityDays / 180, 0, 1)
    const trendNorm    = r.value.revenueTrendPct == null ? 0.5 : clamp(0.5 + r.value.revenueTrendPct / 200, 0, 1)
    const valueScore = Math.round(100 * (0.5 * revenueNorm + 0.2 * taskNorm + 0.15 * recencyNorm + 0.15 * trendNorm))

    const strategicScore = Math.round(0.6 * valueScore + 0.4 * r.reliability.score)

    // Classification — value/reliability tiers, see module doc for rationale.
    const valueTier = valueScore >= 60 ? 'high' : valueScore < 35 ? 'low' : 'medium'
    const relTier    = r.reliability.score >= 65 ? 'high' : r.reliability.score < 40 ? 'low' : 'medium'
    let classification: ClientClass
    if (valueTier === 'high' && relTier === 'high') classification = 'Strategic Client'
    else if (valueTier === 'high') classification = 'High Value Risk'
    else if (valueTier === 'low' && relTier === 'low') classification = 'Watchlist Client'
    else if (relTier === 'high') classification = 'Reliable Small Client'
    else classification = 'Growth Client'

    return {
      clientId: r.clientId, clientName: r.clientName,
      reliability: r.reliability,
      value: { ...r.value, score: valueScore },
      strategicScore, classification,
    }
  })
}
