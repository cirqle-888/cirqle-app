'use client'

import { useState, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { OverflowMenu } from '@/components/ui/overflow-menu'
import Header from '@/components/layout/header'
import AppSelect from '@/components/ui/app-select'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { getStatusColor, getStatusLabel } from '@/lib/utils/invoice'
import {
  classifyInvoice, latestByInvoice, countByInvoice, isPromiseMissed,
  lastFollowupAge, daysOverdue, buildReminderText,
  type FollowupRow, type FollowupGroup,
} from '@/lib/followups/grouping'
import { logFollowup, markInvoiceSent, deleteFollowup, recordPayment } from './actions'
import { buildInvoiceShareText, whatsappShareUrl, publicInvoiceUrl } from '@/lib/invoices/share'
import { buildPartnerStatementTextFromLines } from '@/lib/partners/whatsapp'
import { copyToClipboard } from '@/lib/clipboard'
import { setPartnerGreeting } from '@/app/(dashboard)/dashboard/partners/actions'
import { setClientGreeting } from '@/app/(dashboard)/dashboard/invoices/follow-ups/actions'
import type { MessageTemplates } from '@/lib/messaging/templates'
import { formatDate } from '@/lib/utils/format-date'
import {
  PhoneCall, MessageCircle, Send, Clock, AlertTriangle, CalendarClock,
  ChevronDown, ChevronRight, ExternalLink, Copy, Trash2, History,
  Plus, X, Phone, Inbox, BellRing, CircleDollarSign, CheckCircle2, CreditCard,
  TrendingUp, Handshake,
} from 'lucide-react'
import { todayISO } from '@/lib/utils/local-date'

// ── Types ────────────────────────────────────────────────────────────
export interface FUPartner {
  id:    string
  name:  string
  code:  string | null
  phone: string | null
}

interface FUInvoice {
  id:             string
  invoice_number: string
  status:         string
  issue_date:     string | null
  due_date:       string | null
  currency:       string
  client:         { id: string; name: string; code: string | null; phone: string | null; partner: FUPartner | null } | null
  outstanding:    number | null
  total:          number | null
  hasAllocations: boolean
  public_token:   string | null
}

interface Props {
  invoices:    FUInvoice[]
  followups:   FollowupRow[]
  companyName: string
  showAmounts: boolean
  setupNeeded: boolean
  templates:   MessageTemplates
  partnerGreetings: Record<string, string>
  clientGreetings: Record<string, string>
}

// ── Outcome metadata ─────────────────────────────────────────────────
const OUTCOME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'promised',         label: 'Promised to pay' },
  { value: 'partial_promised', label: 'Promised partial' },
  { value: 'callback',         label: 'Will call back' },
  { value: 'no_response',      label: 'No response' },
  { value: 'disputed',         label: 'Disputed / query' },
  { value: 'sent',             label: 'Reminder sent' },
  { value: 'other',            label: 'Other' },
]
const OUTCOME_LABEL: Record<string, string> = Object.fromEntries(OUTCOME_OPTIONS.map(o => [o.value, o.label]))
function outcomeColor(o: string | null): string {
  switch (o) {
    case 'promised':         return 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400'
    case 'partial_promised': return 'bg-teal-500/15 text-teal-700 border-teal-500/30 dark:text-teal-400'
    case 'callback':         return 'bg-blue-500/15 text-blue-700 border-blue-500/30 dark:text-blue-400'
    case 'no_response':      return 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400'
    case 'disputed':         return 'bg-red-500/15 text-red-700 border-red-500/30 dark:text-red-400'
    case 'sent':             return 'bg-violet-500/15 text-violet-700 border-violet-500/30 dark:text-violet-400'
    default:                 return 'bg-gray-500/15 text-gray-700 border-gray-500/30 dark:text-gray-400'
  }
}

// ── Formatting helpers ───────────────────────────────────────────────
const fmtINR = (n: number | null) =>
  n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtDate = formatDate

const GROUP_META: Record<FollowupGroup, { label: string; hint: string; icon: typeof BellRing; accent: string; dot: string }> = {
  needs_sent: { label: 'Needs to be sent', hint: 'Draft invoices not yet sent to the client', icon: Inbox,    accent: 'text-blue-600 dark:text-blue-400',   dot: 'bg-blue-500' },
  urgent:     { label: 'Urgent follow-up',  hint: 'Overdue, promised date reached, or a chase is due', icon: AlertTriangle, accent: 'text-red-600 dark:text-red-400',  dot: 'bg-red-500' },
  regular:    { label: 'Regular follow-up', hint: 'Sent and unpaid, not yet urgent', icon: BellRing, accent: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
}
const GROUP_ORDER: FollowupGroup[] = ['needs_sent', 'urgent', 'regular']

// ── Group-by clustering (within each section) ──────────────────────────
type ViewMode = 'flat' | 'client' | 'partner' | 'overdue' | 'amount'
const VIEW_MODES: ViewMode[] = ['flat', 'client', 'partner', 'overdue', 'amount']
const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  flat: 'Flat', client: 'By Client', partner: 'By Business Partner', overdue: 'By Overdue', amount: 'By Amount',
}
const NO_PARTNER_KEY = 'no_partner'

function overdueBucket(days: number | null): { key: string; label: string; order: number } {
  if (days == null || days <= 0) return { key: 'not_due', label: 'Not yet due', order: 0 }
  if (days <= 30) return { key: 'd0_30', label: '1–30 days overdue', order: 1 }
  if (days <= 60) return { key: 'd31_60', label: '31–60 days overdue', order: 2 }
  if (days <= 90) return { key: 'd61_90', label: '61–90 days overdue', order: 3 }
  return { key: 'd90p', label: '90+ days overdue', order: 4 }
}
function amountBucket(amt: number): { key: string; label: string; order: number } {
  if (amt < 1000)  return { key: 'lt1k',   label: 'Under ₹1,000',        order: 0 }
  if (amt < 5000)  return { key: 'k1_5',   label: '₹1,000 – ₹5,000',     order: 1 }
  if (amt < 20000) return { key: 'k5_20',  label: '₹5,000 – ₹20,000',    order: 2 }
  return                   { key: 'k20p',  label: '₹20,000+',            order: 3 }
}

interface Cluster { key: string; label: string; items: FUInvoice[] }

function clusterInvoices(list: FUInvoice[], mode: ViewMode): Cluster[] {
  if (mode === 'flat') return [{ key: 'all', label: '', items: list }]
  if (mode === 'client') {
    const map = new Map<string, Cluster>()
    for (const inv of list) {
      const key = inv.client?.id ?? 'none'
      const e = map.get(key) ?? { key, label: inv.client?.name ?? 'No client', items: [] }
      e.items.push(inv)
      map.set(key, e)
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label))
  }
  if (mode === 'partner') {
    const map = new Map<string, Cluster>()
    for (const inv of list) {
      const partner = inv.client?.partner ?? null
      const key = partner?.id ?? NO_PARTNER_KEY
      const label = partner
        ? `${partner.name}${partner.code ? ` · ${partner.code}` : ''}`
        : 'No business partner'
      const e = map.get(key) ?? { key, label, items: [] }
      e.items.push(inv)
      map.set(key, e)
    }
    // Partners first (alphabetical); the unassigned bucket always sinks to the bottom.
    return [...map.values()].sort((a, b) => {
      if (a.key === NO_PARTNER_KEY) return 1
      if (b.key === NO_PARTNER_KEY) return -1
      return a.label.localeCompare(b.label)
    })
  }
  const bucketFn = mode === 'overdue'
    ? (inv: FUInvoice) => overdueBucket(daysOverdue(inv))
    : (inv: FUInvoice) => amountBucket(inv.outstanding ?? 0)
  const map = new Map<string, Cluster & { order: number }>()
  for (const inv of list) {
    const b = bucketFn(inv)
    const e = map.get(b.key) ?? { key: b.key, label: b.label, order: b.order, items: [] }
    e.items.push(inv)
    map.set(b.key, e)
  }
  return [...map.values()].sort((a, b) => a.order - b.order)
}

export default function FollowUpsClient({ invoices, followups, companyName, showAmounts, setupNeeded, templates, partnerGreetings: initialPartnerGreetings, clientGreetings: initialClientGreetings }: Props) {
  const router = useRouter()
  const { toasts, dismiss, success, error: toastError, info } = useToast()

  const [partnerGreetings, setPartnerGreetings] = useState(initialPartnerGreetings)
  const [clientGreetings, setClientGreetings] = useState(initialClientGreetings)
  const [openForm, setOpenForm]       = useState<string | null>(null)
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set())
  const [waInvoice, setWaInvoice]     = useState<string | null>(null) // invoice id whose WhatsApp popover is open
  const [waText, setWaText]           = useState('')
  const [bpCluster, setBpCluster]     = useState<string | null>(null) // cluster id whose partner-statement popover is open
  const [bpText, setBpText]           = useState('')
  // "Needs to be sent" starts collapsed (drafts are lower priority); Urgent/Regular start open.
  const [collapsed, setCollapsed]     = useState<Set<FollowupGroup>>(new Set(['needs_sent']))
  const [viewMode, setViewMode]       = useState<Record<FollowupGroup, ViewMode>>({ needs_sent: 'flat', urgent: 'flat', regular: 'flat' })
  // Collapsed clusters within a grouped (non-flat) view. Keyed by `${group}:${mode}:${clusterKey}`
  // so switching view modes (or groups) doesn't carry over unrelated collapse state.
  const [collapsedClusters, setCollapsedClusters] = useState<Set<string>>(new Set())
  const [busy, setBusy]               = useState<string | null>(null)

  // Form state (single shared form — only one open at a time)
  const [fNote, setFNote]             = useState('')
  const [fOutcome, setFOutcome]       = useState('')
  const [fPromised, setFPromised]     = useState('')
  const [fNext, setFNext]             = useState('')

  // ── Derived maps ───────────────────────────────────────────────────
  const latest   = useMemo(() => latestByInvoice(followups), [followups])
  const counts   = useMemo(() => countByInvoice(followups), [followups])
  const byInvoice = useMemo(() => {
    const m = new Map<string, FollowupRow[]>()
    for (const r of followups) {
      const arr = m.get(r.invoice_id) ?? []
      arr.push(r)
      m.set(r.invoice_id, arr)
    }
    return m // already newest-first from the query
  }, [followups])

  // Client → their sent/partial/overdue invoices (for the aggregated reminder)
  const pendingByClient = useMemo(() => {
    const m = new Map<string, FUInvoice[]>()
    for (const inv of invoices) {
      if (!inv.client) continue
      if (!['sent', 'partial', 'overdue'].includes(inv.status)) continue
      const arr = m.get(inv.client.id) ?? []
      arr.push(inv)
      m.set(inv.client.id, arr)
    }
    return m
  }, [invoices])

  // Business partner → every pending invoice of every client they own. Like
  // pendingByClient, this deliberately spans all three groups (and skips drafts):
  // a partner chases the client's whole outstanding book, not one bucket of it.
  const pendingByPartner = useMemo(() => {
    const m = new Map<string, FUInvoice[]>()
    for (const inv of invoices) {
      const pid = inv.client?.partner?.id
      if (!pid) continue
      if (!['sent', 'partial', 'overdue'].includes(inv.status)) continue
      const arr = m.get(pid) ?? []
      arr.push(inv)
      m.set(pid, arr)
    }
    return m
  }, [invoices])

  // ── Grouping ───────────────────────────────────────────────────────
  const groups = useMemo(() => {
    const out: Record<FollowupGroup, FUInvoice[]> = { needs_sent: [], urgent: [], regular: [] }
    for (const inv of invoices) {
      const g = classifyInvoice(inv, latest.get(inv.id))
      if (g) out[g].push(inv)
    }
    out.needs_sent.sort((a, b) => (a.issue_date || '').localeCompare(b.issue_date || ''))
    out.urgent.sort((a, b) => {
      const od = (daysOverdue(b) ?? -9999) - (daysOverdue(a) ?? -9999)
      if (od !== 0) return od
      return (b.outstanding ?? 0) - (a.outstanding ?? 0)
    })
    out.regular.sort((a, b) => {
      const an = latest.get(a.id)?.next_followup_date || '9999'
      const bn = latest.get(b.id)?.next_followup_date || '9999'
      if (an !== bn) return an.localeCompare(bn)
      return (a.issue_date || '').localeCompare(b.issue_date || '')
    })
    return out
  }, [invoices, latest])

  const totalOutstanding = useMemo(
    () => invoices.reduce((s, i) => s + (i.outstanding ?? 0), 0),
    [invoices],
  )

  // ── Actions ────────────────────────────────────────────────────────
  const resetForm = () => { setFNote(''); setFOutcome(''); setFPromised(''); setFNext('') }

  const toggleForm = (id: string) => {
    setOpenForm(prev => (prev === id ? null : id))
    resetForm()
  }
  const toggleHistory = (id: string) => {
    setOpenHistory(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const toggleGroup = (g: FollowupGroup) => {
    setCollapsed(prev => { const n = new Set(prev); n.has(g) ? n.delete(g) : n.add(g); return n })
  }
  const toggleCluster = (id: string) => {
    setCollapsedClusters(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const setAllClusters = (g: FollowupGroup, clusterIds: string[], collapse: boolean) => {
    setCollapsedClusters(prev => {
      const n = new Set(prev)
      for (const id of clusterIds) collapse ? n.add(id) : n.delete(id)
      return n
    })
  }

  const submitFollowup = useCallback(async (invoiceId: string) => {
    setBusy(invoiceId)
    const res = await logFollowup({
      invoiceId,
      note:             fNote,
      outcome:          fOutcome || null,
      promisedDate:     fPromised || null,
      nextFollowupDate: fNext || null,
    })
    setBusy(null)
    if (!res.ok) { toastError('Could not save', res.error); return }
    success('Follow-up logged')
    setOpenForm(null)
    resetForm()
    router.refresh()
  }, [fNote, fOutcome, fPromised, fNext, router, success, toastError])

  const doBulkFollowup = useCallback(async (clientInvoices: FUInvoice[]) => {
    setBusy('bulk')
    const promises = clientInvoices.map(ci => logFollowup({
      invoiceId: ci.id,
      note: 'Consolidated reminder sent',
      outcome: 'sent',
      promisedDate: null,
      nextFollowupDate: null,
    }))
    await Promise.allSettled(promises)
    success(`Logged follow-up for ${clientInvoices.length} invoice${clientInvoices.length === 1 ? '' : 's'}`)
    setWaInvoice(null)
    setBusy(null)
    router.refresh()
  }, [router, success])

  const doMarkSent = useCallback(async (invoiceId: string) => {
    setBusy(invoiceId)
    const res = await markInvoiceSent(invoiceId)
    setBusy(null)
    if (!res.ok) { toastError('Could not mark sent', res.error); return }
    success('Invoice marked sent', res.dueDate ? `Due ${fmtDate(res.dueDate)}` : undefined)
    router.refresh()
  }, [router, success, toastError])

  const doDeleteFollowup = useCallback(async (id: string) => {
    const res = await deleteFollowup(id)
    if (!res.ok) { toastError('Could not delete', res.error); return }
    success('Follow-up removed')
    router.refresh()
  }, [router, success, toastError])

  const doRecordPayment = useCallback(async (
    invoiceId: string,
    args: { amount: number; date: string; method: string; reference: string },
  ): Promise<boolean> => {
    setBusy(invoiceId)
    const res = await recordPayment({
      invoiceId,
      amount:      args.amount,
      paymentDate: args.date || null,
      method:      args.method || null,
      reference:   args.reference || null,
    })
    setBusy(null)
    if (!res.ok) { toastError('Could not record payment', res.error); return false }
    success(res.status === 'paid' ? 'Payment recorded — invoice fully paid' : 'Partial payment recorded')
    router.refresh()
    return true
  }, [router, success, toastError])

  const clientReminderText = useCallback((inv: FUInvoice, overrideGreeting?: string) => {
    const clientInvoices = inv.client ? (pendingByClient.get(inv.client.id) ?? [inv]) : [inv]
    return buildReminderText({
      clientName:  inv.client?.name ?? 'there',
      companyName,
      invoices:    clientInvoices.map(ci => ({
        invoice_number: ci.invoice_number,
        issue_date:     ci.issue_date,
        outstanding:    ci.outstanding ?? 0,
        link:           publicInvoiceUrl(ci.public_token),
      })),
      showAmounts,
      templates,
      clientGreeting: overrideGreeting !== undefined ? overrideGreeting : (inv.client ? clientGreetings[inv.client.id] : undefined),
    })
  }, [pendingByClient, companyName, showAmounts, templates, clientGreetings])

  const openWa = (inv: FUInvoice) => {
    if (waInvoice === inv.id) { setWaInvoice(null); return }
    setWaText(clientReminderText(inv))
    setWaInvoice(inv.id)
  }

  // Single-invoice share (the client-safe hosted link). Opened synchronously
  // within the click gesture so it isn't blocked as a popup.
  const invoiceShareText = (inv: FUInvoice) => buildInvoiceShareText({
    invoiceNumber: inv.invoice_number,
    clientName:    inv.client?.name ?? null,
    companyName,
    amount:        inv.outstanding,
    dueDate:       inv.due_date,
    showAmounts,
    link:          publicInvoiceUrl(inv.public_token),
    template:      templates.invoiceShare,
  })
  const shareInvoice = (inv: FUInvoice) => {
    window.open(whatsappShareUrl(invoiceShareText(inv), inv.client?.phone ?? null), '_blank', 'noopener,noreferrer')
  }
  const markSentAndShare = (inv: FUInvoice) => {
    // Open WhatsApp first (preserves the user gesture), then mark sent in the background.
    window.open(whatsappShareUrl(invoiceShareText(inv), inv.client?.phone ?? null), '_blank', 'noopener,noreferrer')
    void doMarkSent(inv.id)
  }
  const copyText = async (text: string, label = 'Reminder text copied') => {
    if (await copyToClipboard(text)) success('Copied', label)
    else toastError('Copy failed', 'Select the text and copy manually')
  }

  // ── Business-partner collection statement ──────────────────────────
  // Same message the partner's own dashboard produces (shared builder + the
  // Settings templates), but reachable from the chase list.
  const partnerStatementText = useCallback((partner: FUPartner, overrideGreeting?: string) => {
    const list = pendingByPartner.get(partner.id) ?? []
    const lines = [...list]
      .sort((a, b) => (a.client?.name ?? '').localeCompare(b.client?.name ?? '')
        || a.invoice_number.localeCompare(b.invoice_number))
      .map(inv => ({
        clientName:    inv.client?.name ?? 'Unknown client',
        invoiceNumber: inv.invoice_number,
        pending:       inv.outstanding ?? 0,
        status:        inv.status,
      }))
    const total = lines.reduce((sum, line) => sum + line.pending, 0)
    const greetingName = overrideGreeting !== undefined ? overrideGreeting : partnerGreetings[partner.id]
    return buildPartnerStatementTextFromLines(partner.name, lines, total, templates, greetingName || undefined)
  }, [pendingByPartner, templates, partnerGreetings])

  const openPartnerStatement = (clusterId: string, partner: FUPartner) => {
    if (bpCluster === clusterId) { setBpCluster(null); return }
    setBpText(partnerStatementText(partner))
    setBpCluster(clusterId)
  }

  const sendWhatsApp = (phone: string | null, text: string) => {
    let digits = (phone || '').replace(/\D/g, '')
    if (!digits) { copyText(text); info('No phone on file', 'Reminder copied — paste into WhatsApp'); return }
    if (digits.length === 10) digits = '91' + digits // assume India when no country code
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer')
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen">
      <Header
        title="Follow-ups"
        subtitle="Chase unpaid invoices — log what clients say, track promised dates, send reminders"
        actions={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/invoices/follow-ups/activity"
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors">
              <History className="w-3.5 h-3.5" /> Activity Log
            </Link>
            <Link href="/dashboard/clients/ranking"
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:border-border/80 transition-colors">
              <TrendingUp className="w-3.5 h-3.5" /> Client Ranking
            </Link>
          </div>
        }
      />

      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-5xl mx-auto">
        {/* Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2 mb-6">
          <KpiTile label="Pending invoices" value={String(invoices.length)} icon={Inbox} tint="text-foreground" />
          <KpiTile label="Urgent" value={String(groups.urgent.length)} icon={AlertTriangle} tint="text-red-600 dark:text-red-400" />
          <KpiTile label="To be sent" value={String(groups.needs_sent.length)} icon={Send} tint="text-blue-600 dark:text-blue-400" />
          <KpiTile label="Total outstanding" value={showAmounts ? fmtINR(totalOutstanding) : '—'} icon={CircleDollarSign} tint="text-foreground" />
        </div>

        {setupNeeded && (
          // A migration filename is a developer's problem, not the owner's.
          // The plain-language state leads; the technical fix stays available
          // one click away for whoever actually applies it.
          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            <p>Saving follow-up notes isn&rsquo;t switched on yet. Grouping, reminders and sharing all work — only the written history is unavailable.</p>
            <details className="mt-1.5">
              <summary className="cursor-pointer select-none list-none text-xs opacity-70 hover:opacity-100">Technical details</summary>
              <p className="mt-1 text-xs opacity-80">
                Apply <code className="px-1.5 py-0.5 rounded bg-amber-500/20">20260616120000_invoice_followups.sql</code> in the Supabase SQL editor.
              </p>
            </details>
          </div>
        )}

        {invoices.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-500 mb-3" />
            <p className="font-medium text-foreground">All clear — nothing to follow up</p>
            <p className="text-sm text-muted-foreground mt-1">No draft or unpaid invoices right now.</p>
          </div>
        )}

        {/* Groups */}
        {GROUP_ORDER.map(g => {
          const list = groups[g]
          if (list.length === 0) return null
          const meta = GROUP_META[g]
          const GroupIcon = meta.icon
          const isCollapsed = collapsed.has(g)
          const groupOutstanding = list.reduce((s, i) => s + (i.outstanding ?? 0), 0)
          return (
            <section key={g} className="mb-6">
              <button
                onClick={() => toggleGroup(g)}
                className="w-full flex items-center gap-2.5 mb-3 group"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                <GroupIcon className={`w-4 h-4 ${meta.accent}`} />
                <span className={`text-sm font-semibold ${meta.accent}`}>{meta.label}</span>
                <span className="text-xs font-medium text-muted-foreground bg-secondary border border-border rounded-full px-2 py-0.5">
                  {list.length}
                </span>
                {showAmounts && (
                  <span className="text-xs text-muted-foreground ml-auto mr-1">{fmtINR(groupOutstanding)}</span>
                )}
                {isCollapsed
                  ? <ChevronRight className={`w-4 h-4 text-muted-foreground ${showAmounts ? '' : 'ml-auto'}`} />
                  : <ChevronDown className={`w-4 h-4 text-muted-foreground ${showAmounts ? '' : 'ml-auto'}`} />}
              </button>
              <p className="text-[11px] text-muted-foreground/70 -mt-2 mb-3 ml-6">{meta.hint}</p>

              {!isCollapsed && (() => {
                const mode = viewMode[g]
                const clusters = clusterInvoices(list, mode)
                const clusterIds = clusters.map(c => `${g}:${mode}:${c.key}`)
                const allCollapsed = mode !== 'flat' && clusterIds.length > 0 && clusterIds.every(id => collapsedClusters.has(id))
                return (
                  <>
                    <div className="flex items-center gap-1.5 mb-3 ml-6 flex-wrap">
                      {VIEW_MODES.map(m => (
                        <button
                          key={m}
                          onClick={() => setViewMode(p => ({ ...p, [g]: m }))}
                          className={`text-[10px] font-medium px-2 py-1 rounded-full border transition-colors ${
                            viewMode[g] === m
                              ? 'bg-violet-500/15 border-violet-500/40 text-violet-600 dark:text-violet-300'
                              : 'border-border/40 text-muted-foreground hover:text-foreground'
                          }`}
                        >{VIEW_MODE_LABEL[m]}</button>
                      ))}
                      {mode !== 'flat' && clusterIds.length > 0 && (
                        <button
                          onClick={() => setAllClusters(g, clusterIds, !allCollapsed)}
                          className="text-[10px] font-medium px-2 py-1 rounded-full border border-border/40 text-muted-foreground hover:text-foreground transition-colors"
                        >{allCollapsed ? 'Expand all' : 'Collapse all'}</button>
                      )}
                    </div>
                    <div className="space-y-3">
                      {clusters.map(cluster => {
                        const clusterId = `${g}:${mode}:${cluster.key}`
                        const clusterCollapsed = cluster.label !== '' && collapsedClusters.has(clusterId)
                        // In the partner view, the cluster header doubles as the partner's
                        // own follow-up bar (statement text → copy / WhatsApp / log).
                        // Not in "Needs to be sent": you can't ask a partner to chase an
                        // invoice the client has never received.
                        const partner = mode === 'partner' && g !== 'needs_sent'
                          ? (cluster.items[0]?.client?.partner ?? null)
                          : null
                        const partnerPending = partner ? (pendingByPartner.get(partner.id) ?? []) : []
                        return (
                          <div key={cluster.key}>
                            {cluster.label && (
                              <button
                                onClick={() => toggleCluster(clusterId)}
                                className="w-full flex items-center gap-2 mb-2 ml-6 group"
                              >
                                {clusterCollapsed
                                  ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                                {partner && <Handshake className="w-3.5 h-3.5 text-violet-500 shrink-0" />}
                                <span className="text-xs font-semibold text-foreground">{cluster.label}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {cluster.items.length} invoice{cluster.items.length === 1 ? '' : 's'}
                                  {showAmounts && ` · ${fmtINR(cluster.items.reduce((s, i) => s + (i.outstanding ?? 0), 0))}`}
                                </span>
                              </button>
                            )}

                            {partner && partnerPending.length > 0 && (
                              <div className="ml-6 mb-3">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <button
                                    onClick={() => openPartnerStatement(clusterId, partner)}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-500/15 text-violet-700 border border-violet-500/30 hover:bg-violet-500/25 dark:text-violet-400 transition-colors"
                                  >
                                    <Handshake className="w-3.5 h-3.5" />
                                    {bpCluster === clusterId ? 'Hide statement' : 'Collection statement'}
                                  </button>
                                  <button
                                    onClick={() => copyText(partnerStatementText(partner), 'Partner statement copied')}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-foreground transition-colors"
                                  >
                                    <Copy className="w-3.5 h-3.5" /> Copy statement
                                  </button>
                                  <button
                                    onClick={() => sendWhatsApp(partner.phone, partnerStatementText(partner))}
                                    className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 hover:bg-emerald-500/25 dark:text-emerald-400 transition-colors"
                                  >
                                    <MessageCircle className="w-3.5 h-3.5" /> Send to partner
                                  </button>
                                  <Link
                                    href={`/dashboard/partners/${partner.id}`}
                                    className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                                  >
                                    <ExternalLink className="w-3.5 h-3.5" /> Partner page
                                  </Link>
                                  <span className="text-[10px] text-muted-foreground">
                                    {partnerPending.length} pending invoice{partnerPending.length === 1 ? '' : 's'} across all buckets
                                    {showAmounts && ` · ${fmtINR(partnerPending.reduce((s, i) => s + (i.outstanding ?? 0), 0))}`}
                                  </span>
                                </div>

                                {bpCluster === clusterId && (
                                  <div className="mt-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
                                    <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                                      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-violet-400">
                                        <Handshake className="w-3.5 h-3.5" /> Collection statement for {partner.name}
                                        <span className="text-muted-foreground font-normal hidden sm:inline">(every sent invoice of their clients — drafts excluded)</span>
                                      </div>
                                      <input
                                        type="text"
                                        placeholder={`Name (e.g. Bro, Sir, ${partner.name})`}
                                        value={partnerGreetings[partner.id] || ''}
                                        onChange={e => {
                                          const val = e.target.value
                                          setPartnerGreetings(prev => ({ ...prev, [partner.id]: val }))
                                          setBpText(partnerStatementText(partner, val))
                                        }}
                                        onBlur={async () => {
                                          const val = partnerGreetings[partner.id]
                                          if (val !== initialPartnerGreetings[partner.id]) {
                                            const res = await setPartnerGreeting(partner.id, val || null)
                                            if (!res.ok) toastError('Could not save greeting', res.error)
                                          }
                                        }}
                                        className="text-[10px] bg-background/50 border border-violet-500/30 rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-violet-500/40 w-full sm:w-auto min-w-[120px]"
                                      />
                                    </div>
                                    <textarea
                                      value={bpText}
                                      onChange={e => setBpText(e.target.value)}
                                      rows={Math.min(14, bpText.split('\n').length + 1)}
                                      className="w-full text-xs bg-background border border-border rounded-lg px-3 py-2 text-foreground font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-violet-500/40 resize-y"
                                    />
                                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                                      <button
                                        onClick={() => sendWhatsApp(partner.phone, bpText)}
                                        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                                      >
                                        <Send className="w-3.5 h-3.5" /> Open WhatsApp
                                      </button>
                                      <button
                                        onClick={() => copyText(bpText, 'Partner statement copied')}
                                        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-foreground transition-colors"
                                      >
                                        <Copy className="w-3.5 h-3.5" /> Copy text
                                      </button>
                                      <button
                                        onClick={() => { doBulkFollowup(partnerPending); setBpCluster(null) }}
                                        disabled={busy === 'bulk'}
                                        title="Log 'Reminder sent' on every invoice in this statement"
                                        className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors ml-auto"
                                      >
                                        <CheckCircle2 className="w-3.5 h-3.5" /> Log &quot;Reminder sent&quot; for all {partnerPending.length}
                                      </button>
                                    </div>
                                    {!partner.phone && (
                                      <p className="text-[10px] text-muted-foreground mt-2">
                                        No phone on file for this partner — &quot;Open WhatsApp&quot; will copy the text instead.
                                      </p>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}

                            {!clusterCollapsed && (
                              <div className="space-y-3">
                                {cluster.items.map(inv => (
                                  <InvoiceCard
                                    key={inv.id}
                                    inv={inv}
                                    group={g}
                                    latest={latest.get(inv.id)}
                                    history={byInvoice.get(inv.id) ?? []}
                                    followupCount={counts.get(inv.id) ?? 0}
                                    showAmounts={showAmounts}
                                    busy={busy === inv.id}
                                    formOpen={openForm === inv.id}
                                    historyOpen={openHistory.has(inv.id)}
                                    waOpen={waInvoice === inv.id}
                                    waText={waText}
                                    setWaText={setWaText}
                                    clientGreeting={inv.client ? clientGreetings[inv.client.id] : undefined}
                                    initialClientGreeting={inv.client ? initialClientGreetings[inv.client.id] : undefined}
                                    onClientGreetingChange={(val) => {
                                      if (inv.client) {
                                        setClientGreetings(prev => ({ ...prev, [inv.client!.id]: val }))
                                        setWaText(clientReminderText(inv, val))
                                      }
                                    }}
                                    onClientGreetingBlur={async () => {
                                      if (inv.client) {
                                        const val = clientGreetings[inv.client.id]
                                        if (val !== initialClientGreetings[inv.client.id]) {
                                          const res = await setClientGreeting(inv.client.id, val || null)
                                          if (!res.ok) toastError('Could not save greeting', res.error)
                                        }
                                      }
                                    }}
                                    onToggleForm={() => toggleForm(inv.id)}
                                    onToggleHistory={() => toggleHistory(inv.id)}
                                    onToggleWa={() => openWa(inv)}
                                    onCopyWa={() => copyText(waText)}
                                    onSendWa={() => sendWhatsApp(inv.client?.phone ?? null, waText)}
                                    onLogBulk={() => {
                                      const clientInvoices = inv.client ? (pendingByClient.get(inv.client.id) ?? [inv]) : [inv]
                                      doBulkFollowup(clientInvoices)
                                    }}
                                    onMarkSent={() => doMarkSent(inv.id)}
                                    onMarkSentAndShare={() => markSentAndShare(inv)}
                                    onShareInvoice={() => shareInvoice(inv)}
                                    onCopyInvoice={() => copyText(invoiceShareText(inv))}
                                    onRecordPayment={(args) => doRecordPayment(inv.id, args)}
                                    onSubmit={() => submitFollowup(inv.id)}
                                    onDeleteFollowup={doDeleteFollowup}
                                    fNote={fNote} setFNote={setFNote}
                                    fOutcome={fOutcome} setFOutcome={setFOutcome}
                                    fPromised={fPromised} setFPromised={setFPromised}
                                    fNext={fNext} setFNext={setFNext}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
              })()}
            </section>
          )
        })}
      </div>

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  )
}

// ── KPI tile ──────────────────────────────────────────────────────────
function KpiTile({ label, value, icon: Icon, tint }: { label: string; value: string; icon: typeof Inbox; tint: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1">
        <Icon className="w-3.5 h-3.5" />
        <span className="truncate">{label}</span>
      </div>
      <div className={`text-lg font-bold ${tint}`}>{value}</div>
    </div>
  )
}

// ── Invoice card ────────────────────────────────────────────────────
interface CardProps {
  inv:            FUInvoice
  group:          FollowupGroup
  latest:         FollowupRow | undefined
  history:        FollowupRow[]
  followupCount:  number
  showAmounts:    boolean
  busy:           boolean
  formOpen:       boolean
  historyOpen:    boolean
  waOpen:         boolean
  waText:         string
  setWaText:      (s: string) => void
  clientGreeting?: string
  initialClientGreeting?: string
  onClientGreetingChange?: (val: string) => void
  onClientGreetingBlur?: () => void
  onToggleForm:   () => void
  onToggleHistory:() => void
  onToggleWa:     () => void
  onCopyWa:       () => void
  onSendWa:       () => void
  onLogBulk:      () => void
  onMarkSent:     () => void
  onMarkSentAndShare: () => void
  onShareInvoice: () => void
  onCopyInvoice: () => void
  onRecordPayment:(args: { amount: number; date: string; method: string; reference: string }) => Promise<boolean>
  onSubmit:       () => void
  onDeleteFollowup: (id: string) => void
  fNote: string;     setFNote: (s: string) => void
  fOutcome: string;  setFOutcome: (s: string) => void
  fPromised: string; setFPromised: (s: string) => void
  fNext: string;     setFNext: (s: string) => void
}

function InvoiceCard(p: CardProps) {
  const { inv, group, latest, history, followupCount, showAmounts } = p
  const promiseMissed = isPromiseMissed(inv, latest)
  const od = daysOverdue(inv)
  const isDraftGroup = group === 'needs_sent'

  // Inline payment (card-local state)
  const [payOpen, setPayOpen]     = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payDate, setPayDate]     = useState(() => todayISO())
  const [payMethod, setPayMethod] = useState('bank_transfer')
  const [payRef, setPayRef]       = useState('')
  const togglePay = () => {
    setPayOpen(o => {
      const next = !o
      if (next && inv.outstanding != null) setPayAmount(String(Math.round(inv.outstanding)))
      return next
    })
  }
  const submitPay = async () => {
    const amt = parseFloat(payAmount)
    if (!(amt > 0)) return
    const ok = await p.onRecordPayment({ amount: amt, date: payDate, method: payMethod, reference: payRef })
    if (ok) { setPayOpen(false); setPayRef('') }
  }

  // Due-date helper line
  let dueLine: React.ReactNode = null
  if (!isDraftGroup) {
    if (od != null && od > 0)       dueLine = <span className="text-red-600 dark:text-red-400 font-medium">{od}d overdue</span>
    else if (od != null && od === 0) dueLine = <span className="text-amber-600 dark:text-amber-400 font-medium">due today</span>
    else if (od != null)             dueLine = <span className="text-muted-foreground">{Math.abs(od)}d to go</span>
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="p-4">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground text-sm">{inv.invoice_number}</span>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${getStatusColor(inv.status)}`}>
                {getStatusLabel(inv.status)}
              </span>
              {promiseMissed && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-700 border border-red-500/30 dark:text-red-400">
                  <AlertTriangle className="w-3 h-3" /> Promise missed
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-sm text-muted-foreground min-w-0">
              <span className="truncate">{inv.client?.name ?? 'Unknown client'}</span>
              {inv.client?.phone && (
                <a href={`tel:${inv.client.phone.replace(/[^0-9+]/g, '')}`} className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-700 dark:text-blue-300 hover:underline shrink-0">
                  <Phone className="w-3 h-3" /> {inv.client.phone}
                </a>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="font-bold text-foreground">{fmtINR(inv.outstanding)}</div>
            {showAmounts && inv.total != null && inv.total !== (inv.outstanding ?? 0) && (
              <div className="text-[11px] text-muted-foreground">of {fmtINR(inv.total)}</div>
            )}
          </div>
        </div>

        {/* Meta line: dates + follow-up age + count */}
        <div className="flex items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-muted-foreground flex-wrap">
          <span className="inline-flex items-center gap-1"><CalendarClock className="w-3 h-3" /> Issued {fmtDate(inv.issue_date)}</span>
          {!isDraftGroup && <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> Due {fmtDate(inv.due_date)} {dueLine && <>· {dueLine}</>}</span>}
          <span className={`inline-flex items-center gap-1 ${latest ? '' : 'text-muted-foreground/60'}`}>
            <History className="w-3 h-3" /> {lastFollowupAge(latest)}
          </span>
          {followupCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="w-3 h-3" /> {followupCount} follow-up{followupCount === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {/* Latest note preview */}
        {latest && (latest.note || latest.outcome || latest.promised_date) && (
          <div className="mt-3 rounded-lg bg-secondary/60 border border-border px-3 py-2">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              {latest.outcome && (
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${outcomeColor(latest.outcome)}`}>
                  {OUTCOME_LABEL[latest.outcome] ?? latest.outcome}
                </span>
              )}
              {latest.promised_date && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 dark:text-emerald-400">
                  <CalendarClock className="w-3 h-3" /> Promised {fmtDate(latest.promised_date)}
                </span>
              )}
              {latest.next_followup_date && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-700 border border-blue-500/30 dark:text-blue-400">
                  <BellRing className="w-3 h-3" /> Next {fmtDate(latest.next_followup_date)}
                </span>
              )}
            </div>
            {latest.note && <p className="text-xs text-foreground/90 whitespace-pre-wrap">{latest.note}</p>}
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              {latest.creator?.cqid ?? 'Someone'} · {lastFollowupAge(latest)}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {isDraftGroup ? (
            <>
              <button
                onClick={p.onMarkSent}
                disabled={p.busy}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-blue-500/15 text-blue-700 border border-blue-500/30 hover:bg-blue-500/25 dark:text-blue-400 disabled:opacity-50 transition-colors"
              >
                <Send className="w-3.5 h-3.5" /> {p.busy ? 'Marking…' : 'Mark Sent'}
              </button>
              <button
                onClick={p.onMarkSentAndShare}
                disabled={p.busy}
                title="Mark sent and open WhatsApp with the client invoice link"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 hover:bg-emerald-500/25 dark:text-emerald-400 disabled:opacity-50 transition-colors"
              >
                <MessageCircle className="w-3.5 h-3.5" /> Mark Sent &amp; Share
              </button>
            </>
          ) : (
            <>
              <button
                onClick={p.onShareInvoice}
                title="Share the invoice link via WhatsApp"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 hover:bg-emerald-500/25 dark:text-emerald-400 transition-colors"
              >
                <MessageCircle className="w-3.5 h-3.5" /> Share invoice
              </button>
              {/* Copy / reminder-text are alternatives to Share, not peers of
                  it — behind "…" so the card leads with one obvious action. */}
              <OverflowMenu
                label="More sharing options"
                items={[
                  { label: 'Copy message', icon: Copy, onClick: p.onCopyInvoice },
                  { label: 'Reminder text', icon: BellRing, onClick: p.onToggleWa },
                  ...(history.length > 0 ? [{ label: p.historyOpen ? 'Hide history' : 'Show history', icon: History, onClick: p.onToggleHistory, separatorBefore: true }] : []),
                ]}
              />
            </>
          )}
          {!isDraftGroup && (
            inv.hasAllocations ? (
              <span
                title="Settled via Cash Book allocations — record payment from the Invoices page"
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-secondary border border-border text-muted-foreground/50 cursor-not-allowed"
              >
                <CreditCard className="w-3.5 h-3.5" /> Record payment
              </span>
            ) : (
              <button
                onClick={togglePay}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-500/15 text-violet-700 border border-violet-500/30 hover:bg-violet-500/25 dark:text-violet-400 transition-colors"
              >
                <CreditCard className="w-3.5 h-3.5" /> {payOpen ? 'Cancel payment' : 'Record payment'}
              </button>
            )
          )}
          <button
            onClick={p.onToggleForm}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-foreground transition-colors"
          >
            {p.formOpen ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {p.formOpen ? 'Cancel' : 'Log follow-up'}
          </button>
          <Link
            href={`/dashboard/invoices?id=${inv.id}`}
            className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors ml-auto"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Open invoice
          </Link>
        </div>

        {/* WhatsApp reminder popover */}
        {p.waOpen && (
          <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                <MessageCircle className="w-3.5 h-3.5" /> Reminder message
                <span className="text-muted-foreground font-normal hidden sm:inline">(edit before sending)</span>
              </div>
              <input
                type="text"
                placeholder={`Name (e.g. Bro, Sir, ${inv.client?.name || ''})`}
                value={p.clientGreeting || ''}
                onChange={e => p.onClientGreetingChange?.(e.target.value)}
                onBlur={p.onClientGreetingBlur}
                className="text-[10px] bg-background/50 border border-emerald-500/30 rounded px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/40 w-full sm:w-auto min-w-[120px]"
              />
            </div>
            <textarea
              value={p.waText}
              onChange={e => p.setWaText(e.target.value)}
              rows={Math.min(12, p.waText.split('\n').length + 1)}
              className="w-full text-xs bg-background border border-border rounded-lg px-3 py-2 text-foreground font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-y"
            />
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={p.onSendWa}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
              >
                <Send className="w-3.5 h-3.5" /> Open WhatsApp
              </button>
              <button
                onClick={p.onCopyWa}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-secondary border border-border hover:bg-secondary/70 text-foreground transition-colors"
              >
                <Copy className="w-3.5 h-3.5" /> Copy text
              </button>
              <button
                onClick={p.onLogBulk}
                disabled={p.busy}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors ml-auto"
                title="Mark all these invoices as 'Reminder sent'"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> Log &quot;Reminder sent&quot; for all
              </button>
            </div>
          </div>
        )}

        {/* Record payment form */}
        {payOpen && !isDraftGroup && (
          <div className="mt-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-violet-700 dark:text-violet-400 mb-2">
              <CreditCard className="w-3.5 h-3.5" /> Record payment received
              {inv.outstanding != null && <span className="text-muted-foreground font-normal">· outstanding {fmtINR(inv.outstanding)}</span>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Amount (₹)</label>
                <input
                  type="number" min="0" step="0.01" value={payAmount} autoFocus
                  onChange={e => setPayAmount(e.target.value)}
                  className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Date</label>
                <input
                  type="date" value={payDate}
                  onChange={e => setPayDate(e.target.value)}
                  className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Method</label>
                <AppSelect value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="upi">UPI</option>
                  <option value="cash">Cash</option>
                  <option value="cheque">Cheque</option>
                  <option value="online">Online</option>
                  <option value="other">Other</option>
                </AppSelect>
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Reference</label>
                <input
                  type="text" value={payRef} placeholder="UTR / ref"
                  onChange={e => setPayRef(e.target.value)}
                  className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 mt-2.5">
              <button
                onClick={submitPay}
                disabled={p.busy || !(parseFloat(payAmount) > 0)}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
              >
                <CreditCard className="w-3.5 h-3.5" /> {p.busy ? 'Saving…' : 'Record payment'}
              </button>
              <p className="text-[10px] text-muted-foreground">Paying the full outstanding marks the invoice paid and removes it from this list.</p>
            </div>
          </div>
        )}

        {/* Log follow-up form */}
        {p.formOpen && (
          <div className="mt-3 rounded-lg border border-border bg-secondary/40 p-3 space-y-2.5">
            <textarea
              value={p.fNote}
              onChange={e => p.setFNote(e.target.value)}
              placeholder='What did the client say? e.g. "Spoke to accounts — will transfer by Friday"'
              rows={2}
              autoFocus
              className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y"
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Outcome</label>
                <AppSelect value={p.fOutcome} onChange={e => p.setFOutcome(e.target.value)}>
                  <option value="">—</option>
                  {OUTCOME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </AppSelect>
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Promised payment date</label>
                <input
                  type="date"
                  value={p.fPromised}
                  onChange={e => p.setFPromised(e.target.value)}
                  className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">Next follow-up</label>
                <input
                  type="date"
                  value={p.fNext}
                  onChange={e => p.setFNext(e.target.value)}
                  className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={p.onSubmit}
                disabled={p.busy}
                className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg gradient-bg text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
              >
                <Send className="w-3.5 h-3.5" /> {p.busy ? 'Saving…' : 'Save follow-up'}
              </button>
              <p className="text-[10px] text-muted-foreground">A promised or next-follow-up date that&apos;s today/past moves this invoice to Urgent.</p>
            </div>
          </div>
        )}

        {/* Full history */}
        {p.historyOpen && history.length > 0 && (
          <div className="mt-3 border-t border-border pt-3 space-y-2.5">
            {history.map(h => (
              <div key={h.id} className="flex items-start gap-2 group/h">
                <div className="w-1.5 h-1.5 rounded-full bg-border mt-1.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {h.outcome && (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${outcomeColor(h.outcome)}`}>
                        {OUTCOME_LABEL[h.outcome] ?? h.outcome}
                      </span>
                    )}
                    {h.promised_date && (
                      <span className="text-[10px] text-emerald-700 dark:text-emerald-400">Promised {fmtDate(h.promised_date)}</span>
                    )}
                    {h.next_followup_date && (
                      <span className="text-[10px] text-blue-700 dark:text-blue-400">Next {fmtDate(h.next_followup_date)}</span>
                    )}
                  </div>
                  {h.note && <p className="text-xs text-foreground/90 whitespace-pre-wrap mt-0.5">{h.note}</p>}
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                    {h.creator?.cqid ?? 'Someone'} · {fmtDate(h.created_at)} {new Date(h.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <button
                  onClick={() => p.onDeleteFollowup(h.id)}
                  title="Delete this entry"
                  className="opacity-0 group-hover/h:opacity-100 text-muted-foreground hover:text-red-500 transition-all shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
