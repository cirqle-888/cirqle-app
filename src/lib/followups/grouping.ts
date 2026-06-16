/**
 * Follow-up classification — the SINGLE source of truth for how unpaid invoices
 * are bucketed into Needs-to-be-sent / Urgent / Regular.
 *
 * Pure and dependency-free so BOTH the Follow-ups page (client) and the
 * dashboard widget (server) import the exact same logic — no drift between the
 * page count and the dashboard count (the kind of divergence that caused the
 * old due-date bug).
 */

export type FollowupGroup = 'needs_sent' | 'urgent' | 'regular'

export interface FollowupRow {
  id:                 string
  invoice_id:         string
  note:               string | null
  outcome:            string | null
  promised_date:      string | null
  next_followup_date: string | null
  created_by:         string | null
  created_at:         string
  creator?:           { cqid: string; name: string } | null
}

export interface ClassifiableInvoice {
  id:         string
  status:     string
  issue_date: string | null
  due_date:   string | null
}

const SENT_STATUSES  = ['sent', 'partial', 'overdue']
const DRAFT_STATUSES = ['draft', 'reviewed']
const CLOSED_STATUSES = ['paid', 'cancelled', 'bad_debt']

/** Days after issue an un-followed-up invoice becomes "stale" → Urgent. */
export const STALE_DAYS = 7

export function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

/** Effective due date = explicit due_date, else issue_date + 30 (net-30). */
export function effectiveDueDate(inv: ClassifiableInvoice): Date | null {
  const due = parseDate(inv.due_date)
  if (due) return due
  const iss = parseDate(inv.issue_date)
  if (iss) { const d = new Date(iss); d.setDate(d.getDate() + 30); return d }
  return null
}

export function isInvoiceOverdue(inv: ClassifiableInvoice, today = startOfToday()): boolean {
  if (CLOSED_STATUSES.includes(inv.status)) return false
  const eff = effectiveDueDate(inv)
  return eff ? eff < today : false
}

/** Whole days from effective due date to today. Positive = overdue by N days. */
export function daysOverdue(inv: ClassifiableInvoice, today = startOfToday()): number | null {
  const eff = effectiveDueDate(inv)
  if (!eff) return null
  return Math.floor((today.getTime() - eff.getTime()) / 86400000)
}

/** Whole days since issue (>= 0), or null if no issue date. */
export function daysSinceIssue(inv: ClassifiableInvoice, today = startOfToday()): number | null {
  const iss = parseDate(inv.issue_date)
  if (!iss) return null
  return Math.floor((today.getTime() - iss.getTime()) / 86400000)
}

/** Reduce follow-up rows to the latest (max created_at) per invoice_id. */
export function latestByInvoice(rows: FollowupRow[]): Map<string, FollowupRow> {
  const m = new Map<string, FollowupRow>()
  for (const r of rows) {
    const cur = m.get(r.invoice_id)
    if (!cur || r.created_at > cur.created_at) m.set(r.invoice_id, r)
  }
  return m
}

/** Count follow-up rows per invoice_id. */
export function countByInvoice(rows: FollowupRow[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.invoice_id, (m.get(r.invoice_id) ?? 0) + 1)
  return m
}

/**
 * Classify one invoice into a follow-up bucket.
 * Returns null for invoices that don't belong on the page (paid/cancelled/bad_debt).
 */
export function classifyInvoice(
  inv: ClassifiableInvoice,
  latest: FollowupRow | undefined,
  today = startOfToday(),
): FollowupGroup | null {
  if (DRAFT_STATUSES.includes(inv.status)) return 'needs_sent'
  if (!SENT_STATUSES.includes(inv.status)) return null

  // ── Urgent triggers ──────────────────────────────────────────────
  if (isInvoiceOverdue(inv, today)) return 'urgent'

  const promised = parseDate(latest?.promised_date ?? null)
  if (promised && promised <= today) return 'urgent'   // promised date arrived / passed

  const next = parseDate(latest?.next_followup_date ?? null)
  if (next && next <= today) return 'urgent'           // scheduled chase is due

  if (!latest) {
    const age = daysSinceIssue(inv, today)
    if (age !== null && age >= STALE_DAYS) return 'urgent'  // never contacted + aging
  }

  return 'regular'
}

/** Promised date has passed and the invoice is still unpaid → "Promise missed". */
export function isPromiseMissed(
  inv: ClassifiableInvoice,
  latest: FollowupRow | undefined,
  today = startOfToday(),
): boolean {
  if (!SENT_STATUSES.includes(inv.status)) return false
  const promised = parseDate(latest?.promised_date ?? null)
  return !!promised && promised < today
}

/** Human label for how long ago the last follow-up happened. */
export function lastFollowupAge(latest: FollowupRow | undefined, now = new Date()): string {
  if (!latest) return 'Never followed up'
  const then = new Date(latest.created_at)
  const ms = now.getTime() - then.getTime()
  const days = Math.floor(ms / 86400000)
  if (days <= 0) {
    const hrs = Math.floor(ms / 3600000)
    if (hrs <= 0) {
      const mins = Math.floor(ms / 60000)
      return mins <= 1 ? 'Just now' : `${mins} min ago`
    }
    return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`
  }
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  return months === 1 ? '1 month ago' : `${months} months ago`
}

// ── Summary counts (used by the dashboard widget) ────────────────────
export interface FollowupCounts { needsSent: number; urgent: number; regular: number }

export function summarizeFollowups(
  invoices: ClassifiableInvoice[],
  followups: FollowupRow[],
  today = startOfToday(),
): FollowupCounts {
  const latest = latestByInvoice(followups)
  const counts: FollowupCounts = { needsSent: 0, urgent: 0, regular: 0 }
  for (const inv of invoices) {
    const g = classifyInvoice(inv, latest.get(inv.id), today)
    if (g === 'needs_sent') counts.needsSent++
    else if (g === 'urgent') counts.urgent++
    else if (g === 'regular') counts.regular++
  }
  return counts
}

// ── WhatsApp / shareable reminder text ───────────────────────────────
export interface ReminderInvoice {
  invoice_number: string
  issue_date:     string | null
  outstanding:    number
  link?:          string   // public hosted-invoice URL, appended when present
}

/**
 * Build a WhatsApp-friendly payment reminder. Aggregates ALL of a client's
 * pending (sent/partial/overdue) invoices: one line for a single invoice,
 * an itemised list + count + total for several. Uses WhatsApp *bold* markdown.
 */
export function buildReminderText(opts: {
  clientName:      string
  companyName:     string
  invoices:        ReminderInvoice[]
  showAmounts:     boolean
  currencySymbol?: string
}): string {
  const { clientName, companyName, invoices, showAmounts } = opts
  const sym = opts.currencySymbol ?? '₹'
  const fmtAmt  = (n: number) => `${sym}${Math.round(n).toLocaleString('en-IN')}`
  const fmtDate = (s: string | null) => {
    const d = s ? new Date(s) : null
    return d && !isNaN(d.getTime())
      ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : ''
  }

  const lines: string[] = []
  lines.push(`Hi ${clientName || 'there'},`)
  lines.push('')

  if (invoices.length === 1) {
    const inv = invoices[0]
    const amt = showAmounts ? ` — due *${fmtAmt(inv.outstanding)}*` : ''
    const iss = fmtDate(inv.issue_date)
    lines.push(`This is a gentle reminder from ${companyName} regarding your pending payment:`)
    lines.push('')
    lines.push(`*${inv.invoice_number}*${amt}${iss ? ` (issued ${iss})` : ''}`)
    if (inv.link) lines.push(`View & download: ${inv.link}`)
  } else {
    lines.push(`This is a gentle reminder from ${companyName} regarding your pending payments:`)
    lines.push('')
    for (const inv of invoices) {
      const amt = showAmounts ? ` — ${fmtAmt(inv.outstanding)}` : ''
      const iss = fmtDate(inv.issue_date)
      lines.push(`• *${inv.invoice_number}*${amt}${iss ? ` (issued ${iss})` : ''}`)
      if (inv.link) lines.push(`   ${inv.link}`)
    }
    lines.push('')
    lines.push(`Total invoices pending: *${invoices.length}*`)
    if (showAmounts) {
      const total = invoices.reduce((s, i) => s + i.outstanding, 0)
      lines.push(`Total outstanding: *${fmtAmt(total)}*`)
    }
  }

  lines.push('')
  lines.push('Kindly arrange the payment at your earliest convenience. Thank you!')
  return lines.join('\n')
}
