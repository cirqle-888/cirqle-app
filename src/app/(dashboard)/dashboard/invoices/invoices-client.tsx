'use client'

import { resolveBrandingUrl } from '@/lib/utils/branding'
import QRCode from 'qrcode'
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { usePrivacy } from '@/contexts/privacy-context'
import { useCopy } from '@/lib/hooks/use-copy'
import Header from '@/components/layout/header'
import { RequestApprovalDialog } from '@/components/approvals/request-approval-dialog'
import { ActiveFilterChips } from '@/components/ui/active-filter-chips'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import {
  generateInvoiceNumber,
  getInvoiceDateForTaskMonth,
  buildBillingPeriod,
  toSequenceMonth,
  formatLocalDate,
} from '@/lib/invoices/numbering'
import { createClient } from '@/lib/supabase/client'
import {
  getStatusColor, getStatusLabel, isOverdue,
  isEditable, formatBillingPeriod, getNextAction, compareInvoiceItems,
} from '@/lib/utils/invoice'
import { publicInvoiceUrl, buildInvoiceShareText, whatsappShareUrl } from '@/lib/invoices/share'
import { TEMPLATE_KEYS } from '@/lib/messaging/templates'
import { renderInvoiceHtml } from '@/lib/invoices/render-html'
import type { AgreementBreakdown } from '@/lib/packages/invoice-breakdown'
import { formatCurrency, getCurrencySymbol, round2 } from '@/lib/calculations/currency'
import CurrencyAmountInput, { type RateSource } from '@/components/ui/currency-amount-input'
import {
  FileText, Plus, X, ChevronRight, CheckCircle, Send, CreditCard,
  Trash2, AlertTriangle, Clock, Eye, Lock, Zap, Download, RefreshCw, RotateCw, ListRestart, Undo2, CalendarClock,
  Calendar, Building2, IndianRupee, MoreHorizontal, Search, Filter,
  Printer, TrendingUp, BadgeCheck, CircleDollarSign, Receipt, Edit2, Save,
  History, Tag, Percent, ChevronDown, ChevronUp, ArrowDownToLine, Gift, ExternalLink, Copy,
  Wallet, Link2, ShoppingBag, Share2, Layers, ListTree, ScrollText, Check, AlertCircle,
} from 'lucide-react'
import { logFollowup } from "./follow-ups/actions"
import { recordInvoicePayment, serverResyncInvoiceTasks, getInvoiceDetails } from "./actions"

import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useRole } from '@/contexts/role-context'
import { usePermissions } from '@/contexts/permission-context'
import { PERMS } from '@/lib/permissions/keys'
import type { Currency } from '@/types'
import { formatTaskDate } from '@/lib/utils/format-date'
import { cn, ROW_INTERACTIVE_CLASS, BRANDED_PILL_BASE_CLASS, BRANDED_PILL_SELECTED_CLASS, BRANDED_PILL_ACTIVE_CLASS } from '@/lib/utils'
import { ModalOverlay } from '@/components/ui/modal-overlay'

// Client edit modal only mounts when the user opens it from an invoice's
// client menu. Split off the invoices chunk.
const ClientEditModal = dynamic(
  () => import('@/components/ui/client-edit-modal').then(m => m.ClientEditModal),
  { ssr: false },
)

// Invoice-side entry point into the existing cashbook allocation engine. Only
// mounts when the user opens it from an invoice. See the component for details.
const AllocateFromCashbookModal = dynamic(
  () => import('@/components/invoices/allocate-from-cashbook-modal'),
  { ssr: false },
)

// Add cashbook outflow expenses to an invoice as billable line items.
const AddExpenseModal = dynamic(
  () => import('@/components/invoices/add-expense-modal'),
  { ssr: false },
)

const ReceiptModal = dynamic(
  () => import('@/components/cashbook/receipt-modal'),
  { ssr: false },
)
import type { ReceiptInput } from '@/components/cashbook/receipt-modal'
import { addDaysISO, lastDayOfMonthISO, monthStartISO, todayISO } from '@/lib/utils/local-date'

// ─── Types ────────────────────────────────────────────────────────────────────
interface StatementLedgerRow {
  invoiceNumber?: string
  client?: string
  date?: string
  type?: string
  description?: string
  details?: string
  amount?: number
  balance?: number
}

interface TaskRef {
  id: string; title: string; task_date: string
  status: string; billing_amount_inr: number; currency: string
}
interface ServiceRef { id: string; name: string }
interface InvoiceItem {
  id: string; invoice_id: string; task_id?: string
  description: string; service_id?: string
  quantity: number; unit_price: number; total: number
  currency: string; display_order: number
  task?: TaskRef; service?: ServiceRef
}
interface Payment {
  id: string; amount?: number; payment_date: string
  payment_method: string; reference?: string; notes?: string
  // FX: amount is in the invoice/payment currency; amount_inr is the INR base.
  currency?: string; exchange_rate?: number; amount_inr?: number
  rate_source?: string; rate_date?: string
  // Not columns on `payments` — populated only for a payment just recorded in
  // this session (see handlePayment), from the auto-created cashbook entry.
  // For payments loaded from the server, the receipt looks these up from the
  // linked cashbook_entries row instead (see findLinkedCashbookEntry below).
  receipt_number?: string | null
  bank_account_name?: string | null
}
interface Invoice {
  id: string; invoice_number: string; client_id: string
  status: string; issue_date: string; due_date?: string
  billing_period_start?: string; billing_period_end?: string
  currency: Currency
  // Monetary fields are optional because they are stripped from the server
  // payload for users without `billing.view_amounts` /
  // `billing.view_line_pricing`. UI helpers (fmt, balanceDue) must tolerate
  // the missing values and render a neutral placeholder.
  // total_amount / paid_amount are in the INVOICE currency; *_inr are the INR
  // base snapshots used for company accounting/reporting.
  total_amount?: number; paid_amount?: number
  exchange_rate?: number; total_amount_inr?: number; paid_amount_inr?: number
  subtotal?: number; tax_rate?: number; tax_amount?: number
  discount_amount?: number; previous_balance?: number
  notes?: string; created_at: string; updated_at: string
  expenses_mode?: string   // 'mode_a' | 'mode_b' | 'mode_c' — client display style
  client?: { id: string; name: string; code: string; phone?: string; email?: string; address?: string }
  items?: InvoiceItem[]
  payments?: Payment[]
  // Client expense items billed via cashbook outflow entries.
  expense_items?: {
    id: string
    cashbook_entry_id: string
    description: string
    amount: number           // billing amount (what client sees)
    amount_inr: number
    currency: string
    original_amount?: number
    original_amount_inr?: number
    markup_type?: string
    markup_value?: number
    markup_amount?: number
    notes?: string | null
  }[]
  // Active cashbook→invoice allocations. If any exist, this invoice is paid via
  // the allocation path and must NOT also take a direct "Record Payment".
  // allocated_amount + cashbook_entry are loaded for the relationship display.
  /**
   * Row count from `invoice_items(count)`. Present on every invoice from the
   * list query; `items` is NOT — see ensureDetails.
   */
  item_count?: { count: number }[]
  cashbook_invoice_allocations?: {
    id: string
    deleted_at?: string | null
    allocated_amount?: number
    cashbook_entry?: {
      id: string; reference?: string | null; entry_date?: string; description?: string | null
      receipt_number?: string | null
      bank_account?: { name: string } | null
    } | null
  }[]
}

interface Props {
  initialInvoices: Invoice[]
  clients: { id: string; name: string; code: string; phone?: string; email?: string; address?: string; default_currency?: string }[]
  bankAccounts: { id: string; name: string; is_default?: boolean }[]
  cashbookCategories: { id: string; name: string }[]
  services: { id: string; name: string }[]
  companySettings: Record<string, string>
  exchangeRates: { currency: string; rate_to_inr: number; rate_date?: string }[]
  /** invoice_id → the agreements in force that month, with the work each covered. */
  agreementBreakdowns?: Record<string, AgreementBreakdown[]>
  /**
   * Per-field financial visibility resolved server-side from the user's
   * permission set. When `amounts` is false, total_amount/paid_amount and
   * payment.amount have already been stripped from `initialInvoices`; the
   * client uses this flag to suppress the corresponding UI cells/columns.
   */
  visibility: {
    amounts:     boolean
    /**
     * `billing.view_totals` — the portfolio position across every invoice:
     * total outstanding, how many are overdue, draft value.
     *
     * Separate from `amounts`, which is per-invoice. Someone chasing payment
     * needs each client's balance to write a reminder; that is a different
     * question from what the company is owed in total, and the two are
     * wanted by different people.
     */
    totals:      boolean
    linePricing: boolean
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']
const PAYMENT_METHODS = ['bank_transfer', 'cash', 'upi', 'cheque', 'online', 'other']
const METHOD_LABEL: Record<string, string> = {
  bank_transfer: 'Bank Transfer', cash: 'Cash', upi: 'UPI',
  cheque: 'Cheque', online: 'Online', other: 'Other',
}
const STATUS_PIPELINE = ['draft', 'reviewed', 'sent', 'partial', 'paid']
const STATUS_GROUPS = {
  active: ['draft', 'reviewed', 'sent', 'partial', 'overdue'],
  closed: ['paid', 'cancelled', 'bad_debt'],
}

// ─── Helper ───────────────────────────────────────────────────────────────────
// Tolerant formatter: returns a neutral placeholder when the value was
// stripped server-side (user lacks billing.view_amounts or .view_line_pricing).
// This is the ONLY display path for invoice money in this file, so a single
// `n == null` check guarantees the UI never tries to render hidden values.
function fmt(n: number | undefined | null, currency: Currency = 'INR') {
  if (n == null) return '—'
  return formatCurrency(n, currency)
}
function fmtDate(d?: string) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}
function balanceDue(inv: Invoice): number {
  // For users without `billing.view_amounts` the server strips both fields,
  // so this evaluates to 0. Display sites use `fmt()` which already returns
  // '—' for undefined values, so the user sees a neutral placeholder rather
  // than a misleading "₹0".
  return Math.max(0, (inv.total_amount ?? 0) - (inv.paid_amount ?? 0))
}
/** Display variant — returns the field-stripped sentinel so fmt() can show '—'. */
function balanceDueDisplay(inv: Invoice): number | undefined {
  if (inv.total_amount == null || inv.paid_amount == null) return undefined
  return Math.max(0, inv.total_amount - inv.paid_amount)
}
// INR-base helpers for COMPANY-WIDE rollups (KPI cards) — never mix currencies.
// Per-invoice display stays in the invoice currency via fmt(n, inv.currency).
// Falls back to the raw amount for INR invoices / pre-migration rows.
/**
 * Line-item count for a list row.
 *
 * Prefers the loaded `items` (fresher — an edit updates it immediately) and
 * falls back to the `invoice_items(count)` aggregate the list query ships for
 * invoices whose detail has not been pulled in yet.
 */
function taskCountOf(inv: Invoice): number {
  if (Array.isArray(inv.items)) return inv.items.length
  return inv.item_count?.[0]?.count ?? 0
}
function invTotalInr(inv: Invoice): number { return inv.total_amount_inr ?? inv.total_amount ?? 0 }
function invPaidInr(inv: Invoice): number { return inv.paid_amount_inr ?? inv.paid_amount ?? 0 }
function balanceDueInr(inv: Invoice): number { return Math.max(0, invTotalInr(inv) - invPaidInr(inv)) }
// True when this invoice is paid through the cashbook-allocation path. Such an
// invoice must not also take a direct "Record Payment" (the two would clobber).
function hasActiveAllocations(inv: Invoice): boolean {
  return (inv.cashbook_invoice_allocations || []).some(a => !a.deleted_at)
}
// `payments` has no receipt_number / bank_account of its own — recordInvoicePayment
// auto-creates a matching cashbook_entries inflow (same invoice, date, amount) for
// every direct payment, and THAT row carries the generated receipt number + bank
// account. Correlate a payment back to its entry the same way the "Cash Book
// Allocation" list above already does (date + amount), so the receipt can pull
// the real receipt number and bank name instead of a generic fallback.
function findLinkedCashbookEntry(inv: Invoice, p: Payment) {
  return (inv.cashbook_invoice_allocations || [])
    .filter(a => !a.deleted_at && a.cashbook_entry)
    .find(a => a.cashbook_entry!.entry_date === p.payment_date && a.allocated_amount === (p.amount_inr ?? p.amount))
    ?.cashbook_entry
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function InvoicesClient({ initialInvoices, clients, bankAccounts, cashbookCategories, services, companySettings, exchangeRates, visibility, agreementBreakdowns }: Props) {
  const showAmounts     = visibility.amounts
  const showTotals      = visibility.totals
  const showLinePricing = visibility.linePricing
  const supabase = createClient()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const { role } = useRole()
  const { can, user: permUser } = usePermissions()
  /**
   * May this person produce a CLIENT-FACING document?
   *
   * The PDF is for the client, so it has to carry real prices. A role without
   * billing.view_line_pricing has `unit_price` stripped from every item before
   * it ever reaches the browser, so the invoice it would generate shows a dash
   * in every price cell. That is not a degraded document, it is a wrong one —
   * and it would go out under the company's name.
   *
   * So the answer is not "render it anyway" and not "crash" (which is what it
   * used to do): it is to say plainly that the prices are hidden from them and
   * which permission changes that.
   */
  const canSharePdf =
    permUser.isAdmin || (can(PERMS.BILLING_VIEW_AMOUNTS) && can(PERMS.BILLING_VIEW_LINE_PRICING))
  const noShareReason =
    'Invoice prices are hidden from your role, so the PDF would show a dash in every '
    + 'price. Ask an admin for "View line pricing" to send invoices to clients.'
  const { dn } = usePrivacy()
  const [copiedInvNum, copyInvNum] = useCopy()

  // ── State ──────────────────────────────────────────────────────────────────
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices.map(inv => ({
    ...inv,
    subtotal: (inv as any).subtotal || ((inv.total_amount || 0) + ((inv as any).discount_amount || 0) - ((inv as any).tax_amount || 0) - ((inv as any).previous_balance || 0)),
    tax_rate: inv.tax_rate ?? 0,
    tax_amount: inv.tax_amount ?? 0,
    discount_amount: inv.discount_amount ?? 0,
    previous_balance: inv.previous_balance ?? 0,
  })))
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('id') || null)
  // Invoice id currently being rendered to a PDF file for download (see downloadInvoicePdf).
  const [downloadingInvId, setDownloadingInvId] = useState<string | null>(null)
  // "Include other outstanding invoices" toggle for Preview/Download — per-invoice,
  // NEVER persisted to the DB (see buildInvoiceHtml / toggleIncludeOutstanding).
  // Deliberately distinct from the existing Prev. Balance auto-fill, which writes
  // a permanent value onto the invoice's own total_amount.
  const [includeOutstanding, setIncludeOutstanding] = useState<Set<string>>(new Set())
  const [otherOutstandingByInvoice, setOtherOutstandingByInvoice] = useState<Record<string, number>>({})
  const [loadingOutstandingId, setLoadingOutstandingId] = useState<string | null>(null)

  const [filterStatus, setFilterStatus] = useState<string>(searchParams.get('status') || '')
  const [filterClient, setFilterClient] = useState<string>(searchParams.get('client') || '')
  const [groupByClient, setGroupByClient] = useState(false)
  const [searchFacets, setSearchFacets] = useState<SearchFacet[]>(() => {
    try { const raw = searchParams.get('sf'); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  
  useEffect(() => {
    // `initialInvoices` no longer carries `items` or cashbook allocations —
    // those are fetched per invoice by ensureDetails. So this sync can NOT be a
    // plain reset any more: it would throw away everything already loaded while
    // `detailLoaded` still counted it as loaded, and the detail panel would sit
    // on "0 items" for an invoice that has items until a full page reload.
    // That is exactly what happened — every router.refresh() (realtime events,
    // and the ?id= URL sync on each selection) silently emptied the panel.
    //
    // Carry the loaded detail across the refresh so nothing disappears...
    setInvoices(prev => {
      const carried = new Map(
        prev.filter(i => i.items !== undefined).map(i => [i.id, i]),
      )
      return initialInvoices.map(i => {
        const old = carried.get(i.id)
        return old
          ? { ...i, items: old.items, cashbook_invoice_allocations: old.cashbook_invoice_allocations }
          : i
      })
    })

    // ...but the refresh exists precisely BECAUSE the lines may have changed (a
    // task hitting 'done' adds one), so the carried copy is now suspect. Marking
    // every invoice's detail stale makes the effect below refetch the one on
    // screen; until it lands the panel keeps showing the previous lines rather
    // than flashing an empty state.
    setDetailLoaded(new Set())
  }, [initialInvoices])

  // ── Supabase Realtime: keep the invoice list live ─────────────────────────
  // The task → invoice sync is fully server-side (a task hitting 'done' creates/
  // updates its client-month draft line; un-doing or deleting it removes the
  // line). This subscription pushes that change to an already-open Invoices page
  // so it never goes stale — router.refresh() re-runs the server component and
  // flows fresh data through the initialInvoices effect above, preserving all
  // local UI state (open panel, filters, selection).
  //
  // Debounced: a batch generate (or a multi-line retotal) fires many row events;
  // 1200 ms coalesces the burst into a single refetch while still feeling live.
  // Unique channel name per mount so React Strict Mode's dev double-effect
  // remount doesn't collide with an in-flight removeChannel.
  //
  // EGRESS: `router.refresh()` re-runs the 500-invoice server query above —
  // by far the heaviest response in the app. Three unfiltered whole-table
  // subscriptions meant ANY invoice_items write by ANY user (every task hitting
  // 'done' writes one) re-downloaded the whole list into EVERY open tab. Two
  // brakes now sit in front of that:
  //   1. a much longer debounce, so a batch generate coalesces into one refetch;
  //   2. a hard skip while the tab is hidden — a backgrounded Invoices tab is
  //      the single worst offender, and the visibilitychange handler below
  //      refreshes once on return so it still can't go stale.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let pendingWhileHidden = false

    const doRefresh = () => { timer = null; pendingWhileHidden = false; router.refresh() }
    const trigger = () => {
      if (document.visibilityState === 'hidden') { pendingWhileHidden = true; return }
      if (timer) clearTimeout(timer)
      timer = setTimeout(doRefresh, 4000)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && pendingWhileHidden) doRefresh()
    }

    const channel = supabase
      .channel(`invoices-live-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, trigger)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_items' }, trigger)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoice_expense_items' }, trigger)
      .subscribe()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      supabase.removeChannel(channel)
    }
  }, [supabase, router])

  const [searchDraft, setSearchDraft] = useState('')
  const activeFacets = useMemo<SearchFacet[]>(
    () => searchDraft.trim() ? [...searchFacets, { field: 'any', op: 'contains' as const, text: searchDraft.trim() }] : searchFacets,
    [searchFacets, searchDraft],
  )
  const [tab, setTab] = useState<'active' | 'closed' | 'all'>((searchParams.get('tab') as any) || 'active')

  const idFromUrl = searchParams.get('id')
  useEffect(() => {
    if (idFromUrl && idFromUrl !== selectedId) {
      setSelectedId(idFromUrl)
      setPanelMode('detail')
    }
  }, [idFromUrl])

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())

    if (filterStatus) params.set('status', filterStatus); else params.delete('status')
    if (filterClient) params.set('client', filterClient); else params.delete('client')
    if (searchFacets.length) params.set('sf', JSON.stringify(searchFacets)); else params.delete('sf')
    if (tab && tab !== 'active') params.set('tab', tab); else params.delete('tab')
    if (selectedId) params.set('id', selectedId); else params.delete('id')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [filterStatus, filterClient, searchFacets, tab, selectedId, pathname, router, searchParams])
  const [editClientId, setEditClientId] = useState<string | null>(null)

  // Panel modes
  const [panelMode, setPanelMode] = useState<'detail' | 'pay' | 'new' | 'generate' | 'batch_generate' | 'discounts'>('detail')
  const [saving, setSaving] = useState(false)
  // Invoice currently being resynced from its tasks — drives the spinner on that row's button.
  const [resyncingId, setResyncingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Bulk actions
  const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set())
  // Agreement breakdowns the user has expanded, keyed `${invoiceId}:${packageId}`.
  // Collapsed by default: the covered work is context, not the bill.
  const [expandedAgreements, setExpandedAgreements] = useState<Set<string>>(new Set())
  // Invoices whose line items / allocations have been pulled in. See ensureDetails.
  const [detailLoaded, setDetailLoaded] = useState<Set<string>>(new Set())
  // Ids whose detail fetch FAILED. Without this the panel had no third state:
  // "not loaded" rendered as a spinner, so a refused or failed fetch span
  // forever with nothing to click and nothing said. See ensureDetails.
  const [detailFailed, setDetailFailed] = useState<Set<string>>(new Set())
  const [isUpdatingBulk, setIsUpdatingBulk] = useState(false)

  // Confirmation modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void
  } | null>(null)

  // "Allocate From Cash Book" — the invoice this modal is open for, if any.
  const [allocatingInvoice, setAllocatingInvoice] = useState<Invoice | null>(null)

  // "Request approval" — the invoice this dialog is open for, if any.
  const [approvalInvoice, setApprovalInvoice] = useState<{ id: string; invoice_number: string; client_id: string | null } | null>(null)

  // "Add Client Expenses" — the invoice this modal is open for, if any.
  const [addExpenseInvoice, setAddExpenseInvoice] = useState<Invoice | null>(null)

  // Payment form. `amount` is in the payment `currency`; `amountInr` is the
  // INR base; `rate` is rate_to_inr. Defaults to the invoice currency when the
  // pay panel opens (see openPayPanel).
  const defaultBankAccountId = useMemo(() => bankAccounts.find(b => b.is_default)?.id || '', [bankAccounts])

  const [payForm, setPayForm] = useState({
    amount: '', currency: 'INR' as Currency, rate: '', amountInr: '', rateSource: 'settings' as RateSource,
    payment_date: todayISO(),
    payment_method: 'bank_transfer', reference: '', notes: '', bank_account_id: defaultBankAccountId,
  })

  // currency → rate_to_inr, from Settings/exchange_rates (for the FX widget).
  const rateMap = useMemo(() => {
    const m: Record<string, number> = {}
    exchangeRates.forEach(r => { m[r.currency] = r.rate_to_inr })
    return m
  }, [exchangeRates])

  // Creation rate stamped on a new invoice (INR → 1, else the settings rate).
  // total_amount_inr is a DB-generated column (total_amount × exchange_rate), so
  // we only ever need to persist this rate, never the INR snapshot itself.
  // Issue-date book rate snapshotted onto a new invoice. For a foreign currency
  // with no Settings rate we must NOT silently store 1.0 (it makes total_amount_inr
  // and realised FX meaningless). The interactive create path blocks outright; the
  // auto/group paths warn loudly here so the gap is visible rather than silent.
  const creationRate = (cur?: string) => {
    if (!cur || cur === 'INR') return 1
    const r = rateMap[cur]
    if (r && r > 0) return r
    console.warn(`[invoice] No exchange rate for ${cur} — snapshotting 1.0. Set it in Settings → Exchange Rates so FX/INR totals are correct.`)
    return 1
  }

  // New invoice form (manual override)
  const [newForm, setNewForm] = useState({
    client_id: '', currency: 'INR' as Currency,
    issue_date: todayISO(),
    due_date: '', notes: '',
    items: [{ description: '', quantity: 1, unit_price: 0, total: 0, service_id: '' }],
  })

  // Inline edit state for draft items
  const [removingItemId, setRemovingItemId] = useState<string | null>(null)
  // Safe force-edit — requires reason before unlocking
  const [forceEditId, setForceEditId]         = useState<string | null>(null)
  const [forceEditReason, setForceEditReason] = useState('')
  const [editReasonModal, setEditReasonModal] = useState<string | null>(null)   // invoice id pending unlock
  const [editReasonInput, setEditReasonInput] = useState('')

  // Change logs for selected invoice
  const [changeLogs, setChangeLogs] = useState<any[]>([])
  const [changeLogsLoading, setChangeLogsLoading] = useState(false)
  const [showChangeLogs, setShowChangeLogs] = useState(false)

  // Stats bar collapse — initialised lazily so the first paint matches the
  // user's saved preference (or "collapsed on mobile" as a sensible default).
  // Saves vertical space on phones where the 6 action tiles dominate the screen.
  const [statsCollapsed, setStatsCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const saved = window.localStorage.getItem('invoices-stats-collapsed')
    if (saved === '1') return true
    if (saved === '0') return false
    // Collapsed by default everywhere. Expanded, the stat tiles + mode tiles +
    // stage cards + dues strip pushed the actual invoice list below the fold
    // and put ~19 controls ahead of it. The summary line stays visible and one
    // click brings the full panel back — the preference is remembered.
    return true
  })
  function toggleStats() {
    setStatsCollapsed(prev => {
      const next = !prev
      try { window.localStorage.setItem('invoices-stats-collapsed', next ? '1' : '0') } catch {}
      return next
    })
  }

  // Discount calculator
  const [showDiscount, setShowDiscount]         = useState(false)
  const [discountCalc, setDiscountCalc]         = useState<any | null>(null)
  const [discountLoading, setDiscountLoading]   = useState(false)
  const [manualDiscount, setManualDiscount]     = useState('')
  const [discountReason, setDiscountReason]     = useState('')

  // Advance payment toggle in pay panel
  const [isAdvancePayment, setIsAdvancePayment] = useState(false)

  // Generate invoice from date range
  const [genForm, setGenForm] = useState({
    client_id: '', mode: 'range' as 'range' | 'day',
    date_from: monthStartISO(),
    date_to: todayISO(),
    specific_date: todayISO(),
  })
  const [genTasks, setGenTasks] = useState<any[]>([])
  const [genLoading, setGenLoading] = useState(false)
  const [genSelectedIds, setGenSelectedIds] = useState<Set<string>>(new Set())

  // Financial analytics panel
  const [analyticsTab, setAnalyticsTab] = useState<'discounts' | 'bad_debts' | 'overdue' | 'advances' | 'job_losses' | 'expenses'>('discounts')
  const [expenseReport, setExpenseReport]     = useState<any[]>([])
  const [expenseReportLoading, setExpenseReportLoading] = useState(false)
  const [expenseReportLoaded, setExpenseReportLoaded]   = useState(false)
  const [discAnalytics, setDiscAnalytics]               = useState<any[]>([])
  const [discAnalyticsLoading, setDiscAnalyticsLoading] = useState(false)
  const [discAnalyticsLoaded, setDiscAnalyticsLoaded]   = useState(false)
  const [discFilterClient, setDiscFilterClient]         = useState('')
  const [advancePayments, setAdvancePayments]           = useState<any[]>([])
  const [advanceLoading, setAdvanceLoading]             = useState(false)
  const [advanceLoaded, setAdvanceLoaded]               = useState(false)
  const [jobLosses, setJobLosses]                       = useState<any[]>([])
  const [jobLossesLoading, setJobLossesLoading]         = useState(false)
  const [jobLossesLoaded, setJobLossesLoaded]           = useState(false)
  const [analyticsFilterClient, setAnalyticsFilterClient] = useState('')
  const [expandedLossId, setExpandedLossId]               = useState<string | null>(null)
  const [receiptPayment, setReceiptPayment]               = useState<any>(null)

  // Batch generate state
  const [batchGroups, setBatchGroups] = useState<{
    key: string; client_id: string; client_name: string; client_code: string;
    month: string; taskCount: number; total: number; currency: string;
    taskIds: string[]; default_currency?: string
    tasks?: { id: string; title: string; task_date: string; billing_amount_inr: number; currency: string }[]
    expenses?: { id: string; description: string | null; amount_inr: number; entry_date: string }[]
  }[]>([])
  const [batchExpandedKey, setBatchExpandedKey] = useState<string | null>(null)
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set())
  const [batchGenerating, setBatchGenerating] = useState(false)
  const [batchDone, setBatchDone] = useState(0)
  // Batch panel filters
  const [batchFilterClient, setBatchFilterClient] = useState('')
  const [batchFilterMonthFrom, setBatchFilterMonthFrom] = useState('')
  const [batchFilterMonthTo, setBatchFilterMonthTo] = useState('')
  const [batchFilterMinAmount, setBatchFilterMinAmount] = useState('')
  const [batchSortBy, setBatchSortBy] = useState<'client_asc' | 'month_asc' | 'month_desc' | 'amount_desc'>('month_asc')

  // Invoice preview modal
  const [previewInv, setPreviewInv] = useState<Invoice | null>(null)

  // ── Navigation guard: warn before leaving while new invoice form is open ──
  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, which silently trapped
  // the user on this page — every sidebar click was refused with no prompt.
  const [leaveGuard, setLeaveGuard] = useState<{ proceed: () => void } | null>(null)
  const newFormDirty = panelMode === 'new' && (
    newForm.client_id !== '' ||
    newForm.notes !== '' ||
    newForm.items.some(it => it.description.trim() !== '' || it.unit_price > 0)
  )
  useEffect(() => {
    if (!newFormDirty) return

    // 1. Browser close / refresh / external navigation
    const beforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)

    // 2. SPA navigation — patch history.pushState so sidebar/link clicks are caught too
    const origPush    = window.history.pushState.bind(window.history)
    const origReplace = window.history.replaceState.bind(window.history)

    function guard(proceed: () => void) {
      setLeaveGuard({ proceed })
    }

    window.history.pushState = function (...args: Parameters<typeof origPush>) {
      guard(() => origPush(...args))
    }
    window.history.replaceState = function (...args: Parameters<typeof origReplace>) {
      guard(() => origReplace(...args))
    }

    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.history.pushState    = origPush
      window.history.replaceState = origReplace
      setLeaveGuard(null)
    }
  }, [newFormDirty])

  // Cmd+S / Ctrl+S: create invoice when new panel is open
  const createManualInvoiceRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && panelMode === 'new') {
        e.preventDefault()
        createManualInvoiceRef.current?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [panelMode])

  // Pull line items for whichever invoice is on screen. The detail panel, the
  // preview and the PDF all read `inv.items`, and the list query no longer
  // ships it — so this is what makes the detail view whole. Runs once per
  // invoice; ensureDetails no-ops for anything already loaded.
  useEffect(() => {
    const id = previewInv?.id || selectedId
    if (id && !detailLoaded.has(id) && !detailFailed.has(id)) void ensureDetails([id])
    // ensureDetails closes over `invoices`; re-running it on every list change
    // would refetch endlessly. `detailLoaded` is the real guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, previewInv?.id, detailLoaded, detailFailed])

  // ── Derived ────────────────────────────────────────────────────────────────
  const selectedInv = useMemo(() => invoices.find(i => i.id === selectedId) || null, [invoices, selectedId])

  // Tokenized search field map (Invoice # / Client / Amount + operators).
  const INVOICE_FIELDS: Record<string, FacetFieldDef> = useMemo(() => ({
    number: { type: 'text',   get: (inv: any) => inv.invoice_number },
    client: { type: 'text',   get: (inv: any) => inv.client?.name },
    amount: { type: 'number', get: (inv: any) => inv.total_amount_inr ?? inv.total_amount },
  }), [])
  const invoiceGeneric = (inv: any) => `${inv.invoice_number || ''} ${inv.client?.name || ''}`

  const filtered = useMemo(() => {
    const list = invoices.filter(inv => {
      const inTab = tab === 'all'
        ? true
        : tab === 'active'
          ? STATUS_GROUPS.active.includes(inv.status) || (isOverdue(inv.due_date || '', inv.status, inv.issue_date) && inv.status !== 'paid')
          : STATUS_GROUPS.closed.includes(inv.status)
      if (!inTab) return false
      // 'overdue' is never a literal status value — it's derived from due_date
      // vs. today (see isOverdue). Match the same computed state the red
      // "Overdue" badge on each row uses, not a literal status-column equality.
      if (filterStatus === 'overdue') {
        if (!isOverdue(inv.due_date || '', inv.status, inv.issue_date) || inv.status === 'paid') return false
      } else if (filterStatus && inv.status !== filterStatus) {
        return false
      }
      if (filterClient && inv.client_id !== filterClient) return false
      if (activeFacets.length && !recordMatchesFacets(activeFacets, inv, INVOICE_FIELDS, invoiceGeneric)) return false
      return true
    })
    // Sort: drafts first (newest period), then by created_at desc
    return list.sort((a, b) => {
      const ai = STATUS_PIPELINE.indexOf(a.status)
      const bi = STATUS_PIPELINE.indexOf(b.status)
      if (ai !== bi) return ai - bi
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [invoices, tab, filterStatus, filterClient, activeFacets])

  // Client groups for the list panel — only computed when groupByClient is on.
  // Sorted by group balance-due desc (clients who owe the most surface first);
  // within a group, `filtered`'s existing sort order (drafts first, then newest) is kept.
  type ClientGroup = { clientId: string; clientName: string; invoices: Invoice[]; totalInr: number; balanceInr: number }
  const clientGroups = useMemo<ClientGroup[]>(() => {
    if (!groupByClient) return []
    const map = new Map<string, ClientGroup>()
    for (const inv of filtered) {
      const key = inv.client_id || '—'
      let g = map.get(key)
      if (!g) {
        g = { clientId: key, clientName: inv.client?.name || 'No client', invoices: [], totalInr: 0, balanceInr: 0 }
        map.set(key, g)
      }
      g.invoices.push(inv)
      g.totalInr += invTotalInr(inv)
      g.balanceInr += balanceDueInr(inv)
    }
    return [...map.values()].sort((a, b) => b.balanceInr - a.balanceInr || a.clientName.localeCompare(b.clientName))
  }, [filtered, groupByClient])

  // Summary stats
  const stats = useMemo(() => {
    const active = invoices.filter(i => !['paid', 'cancelled', 'bad_debt'].includes(i.status))
    const drafts = invoices.filter(i => i.status === 'draft')
    const overdue = invoices.filter(i => isOverdue(i.due_date || '', i.status, i.issue_date))
    return {
      // Company-wide KPI cards are shown in ₹ — sum the INR snapshots, not the
      // raw invoice-currency amounts (which would mix SAR/USD/INR together).
      outstanding: active.reduce((s, i) => s + balanceDueInr(i), 0),
      overdueAmt: overdue.reduce((s, i) => s + balanceDueInr(i), 0),
      draftCount: drafts.length,
      draftTotal: drafts.reduce((s, i) => s + invTotalInr(i), 0),
      overdueCount: overdue.length,
      // Stage-wise value cards: count + ₹ value sitting in each pipeline stage.
      // 'overdue' is derived (due_date vs today), matching the list filter and
      // row badge — the other four are literal status buckets. Amounts are the
      // balance due (₹ snapshot) — for draft/reviewed nothing is paid yet, so
      // balance == total and the semantics stay uniform across all five cards.
      stages: (['draft', 'reviewed', 'sent', 'partial'] as const).reduce((acc, s) => {
        const list = invoices.filter(i => i.status === s)
        acc[s] = { count: list.length, amount: list.reduce((sum, i) => sum + balanceDueInr(i), 0) }
        return acc
      }, {
        overdue: { count: overdue.length, amount: overdue.reduce((s, i) => s + balanceDueInr(i), 0) },
      } as Record<string, { count: number; amount: number }>),
      // Month-wise outstanding dues: unpaid balances of active invoices grouped
      // by due month (fallback: issue month), oldest first.
      monthDues: (() => {
        const map = new Map<string, { label: string; count: number; amount: number }>()
        for (const inv of active) {
          const due = balanceDueInr(inv)
          if (due <= 0) continue
          const d = inv.due_date || inv.issue_date || inv.created_at
          if (!d) continue
          const dt = new Date(d)
          if (isNaN(dt.getTime())) continue
          const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
          const cur = map.get(key) || {
            label: dt.toLocaleString('en-IN', { month: 'short' }) + ` ’${String(dt.getFullYear()).slice(2)}`,
            count: 0, amount: 0,
          }
          cur.count += 1
          cur.amount += due
          map.set(key, cur)
        }
        return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => ({ key, ...v }))
      })(),
    }
  }, [invoices])

  // ── Actions ────────────────────────────────────────────────────────────────
  function selectInvoice(id: string) {
    if (id !== selectedId) {
      // Reset per-invoice UI state when switching invoices
      setShowDiscount(false)
      setShowChangeLogs(false)
      setChangeLogs([])
      setDiscountCalc(null)
      setManualDiscount('')
      setDiscountReason('')
      if (forceEditId && forceEditId !== id) lockEdit()
    }
    setSelectedId(id === selectedId ? null : id)
    setPanelMode('detail')
  }

  /**
   * Outcome-bearing status changes confirm first; ordinary progress
   * (draft → reviewed → sent → paid) stays one click.
   *
   * `cancelled` and `bad_debt` write off real revenue, and reverting to
   * `draft` pushes every linked task back to Done where it can be invoiced a
   * second time — all three used to fire from a 10px chip with no warning.
   */
  function requestStatusChange(inv: Invoice, newStatus: string) {
    const linkedTasks = (inv.items || []).filter(li => li.task_id).length
    const amount = fmt(invTotalInr(inv))
    const consequence: Record<string, string> = {
      cancelled: `Writes off ${amount} — the invoice stops counting as revenue or as money owed.`,
      bad_debt: `Marks ${amount} as never going to be collected. It stays on record but stops counting as money owed.`,
      draft: linkedTasks > 0
        ? `${linkedTasks} linked task${linkedTasks === 1 ? '' : 's'} return to Done and can be invoiced again — watch for a duplicate invoice.`
        : 'The invoice returns to Draft and stops counting as sent.',
    }
    if (!consequence[newStatus]) { void updateStatus(inv.id, newStatus); return }
    setConfirmModal({
      title: `Set ${inv.invoice_number} to ${getStatusLabel(newStatus)}?`,
      body: consequence[newStatus],
      confirmLabel: `Set ${getStatusLabel(newStatus)}`,
      danger: newStatus !== 'draft',
      onConfirm: () => { setConfirmModal(null); void updateStatus(inv.id, newStatus) },
    })
  }

  async function updateStatus(invoiceId: string, newStatus: string) {
    if (newStatus === 'paid') {
      const inv = invoices.find(i => i.id === invoiceId)
      const due = inv ? balanceDueInr(inv) : 0
      if (due > 0.5) {
        toastError(`Can't mark Paid — ${fmt(due)} still outstanding. Record the payment or allocation first.`)
        return
      }
    }
    setSaving(true)
    try {
      const updates: any = { status: newStatus, updated_at: new Date().toISOString() }
      // Auto-set due date when sending: net-30 from the invoice's ISSUE date
      // (not "today") so back-dated invoices get a correct — possibly already
      // overdue — due date instead of always landing 30 days in the future.
      if (newStatus === 'sent' && !invoices.find(i => i.id === invoiceId)?.due_date) {
        const inv = invoices.find(i => i.id === invoiceId)
        updates.due_date = addDaysISO(inv?.issue_date || todayISO(), 30)
      }
      const { error } = await supabase.from('invoices').update(updates).eq('id', invoiceId)
      if (error) { toastError(error.message); return }

      // When reverting to draft OR cancelling, free tasks back to done
      if (newStatus === 'draft' || newStatus === 'cancelled') {
        const inv = invoices.find(i => i.id === invoiceId)
        const taskIds = (inv?.items || []).map(it => it.task_id).filter(Boolean) as string[]
        if (taskIds.length) await supabase.from('tasks').update({ status: 'done' }).in('id', taskIds)
      }
      // When marking sent, mark tasks invoiced
      if (newStatus === 'sent') {
        const inv = invoices.find(i => i.id === invoiceId)
        const taskIds = (inv?.items || []).map(it => it.task_id).filter(Boolean) as string[]
        if (taskIds.length) await supabase.from('tasks').update({ status: 'invoiced' }).in('id', taskIds)
      }

      setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, ...updates } : i))
      success(`Invoice ${getStatusLabel(newStatus)}`)
    } finally {
      setSaving(false)
    }
  }

  async function removeItem(invoiceId: string, itemId: string) {
    setRemovingItemId(itemId)
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv || !isEditable(inv.status)) { setRemovingItemId(null); return }

    const item = inv.items?.find(it => it.id === itemId)
    await supabase.from('invoice_items').delete().eq('id', itemId)

    // Free task back to 'done' if it was invoiced
    if (item?.task_id) {
      await supabase.from('tasks').update({ status: 'done' }).eq('id', item.task_id)
    }

    // Recalculate totals
    const newItems = (inv.items || []).filter(it => it.id !== itemId)
    const newSubtotal = newItems.reduce((s, it) => s + it.total, 0)
    const newTax = newSubtotal * (inv.tax_rate || 0) / 100
    const newTotal = newSubtotal + newTax - (inv.discount_amount || 0) + (inv.previous_balance || 0)
    await supabase.from('invoices').update({
      subtotal: newSubtotal, tax_amount: newTax, total_amount: newTotal, updated_at: new Date().toISOString(),
    }).eq('id', invoiceId)

    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, items: newItems, subtotal: newSubtotal, tax_amount: newTax, total_amount: newTotal }
      : i
    ))
    setRemovingItemId(null)
  }

  async function updateTaxRate(invoiceId: string, taxRate: number) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    const sub = inv.subtotal || inv.total_amount || 0
    const taxAmt = sub * taxRate / 100
    const total = sub + taxAmt - (inv.discount_amount || 0) + (inv.previous_balance || 0)
    await supabase.from('invoices').update({
      tax_rate: taxRate, tax_amount: taxAmt, total_amount: total, updated_at: new Date().toISOString(),
    }).eq('id', invoiceId)
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, tax_rate: taxRate, tax_amount: taxAmt, total_amount: total }
      : i
    ))
  }

  // Manually correct a foreign invoice's exchange rate. total_amount_inr is a
  // generated column (total_amount × exchange_rate) so it recomputes server-side;
  // we mirror it locally for instant display. Lets the user override the
  // auto-fetched Settings rate with the real rate the invoice was billed at.
  async function updateExchangeRate(invoiceId: string, newRate: number) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv || !(newRate > 0)) return
    await supabase.from('invoices')
      .update({ exchange_rate: newRate, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
    if (forceEditId === invoiceId) await logChange(invoiceId, 'exchange_rate', String(inv.exchange_rate ?? 1), String(newRate))
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, exchange_rate: newRate, total_amount_inr: round2((i.total_amount || 0) * newRate) }
      : i
    ))
  }

  async function updateInvoiceCurrency(invoiceId: string, newCurrency: Currency) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv || !isEditable(inv.status)) return
    const newRate = newCurrency === 'INR' ? 1 : (rateMap[newCurrency] || 1)
    await supabase.from('invoices')
      .update({ currency: newCurrency, exchange_rate: newRate, updated_at: new Date().toISOString() })
      .eq('id', invoiceId)
    await supabase.from('invoice_items')
      .update({ currency: newCurrency })
      .eq('invoice_id', invoiceId)
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? {
          ...i,
          currency: newCurrency,
          exchange_rate: newRate,
          total_amount_inr: round2((i.total_amount || 0) * newRate),
          items: (i.items || []).map(it => ({ ...it, currency: newCurrency })),
        }
      : i
    ))
  }

  async function updateExpensesMode(invoiceId: string, mode: string) {
    await supabase.from('invoices').update({ expenses_mode: mode, updated_at: new Date().toISOString() }).eq('id', invoiceId)
    setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, expenses_mode: mode } : i))
  }

  async function updateItemDescription(itemId: string, invoiceId: string, description: string) {
    const inv = invoices.find(i => i.id === invoiceId)
    const oldDesc = inv?.items?.find(it => it.id === itemId)?.description || ''
    await supabase.from('invoice_items').update({ description }).eq('id', itemId)
    if (forceEditId === invoiceId) await logChange(invoiceId, 'item_description', oldDesc, description)
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, items: (i.items || []).map(it => it.id === itemId ? { ...it, description } : it) }
      : i
    ))
  }

  async function updateItemPrice(itemId: string, invoiceId: string, unitPrice: number) {
    const inv = invoices.find(i => i.id === invoiceId)
    const item = inv?.items?.find(it => it.id === itemId)
    if (!item) return
    const oldPrice = item.unit_price
    const newTotal = unitPrice * item.quantity
    await supabase.from('invoice_items').update({ unit_price: unitPrice, total: newTotal }).eq('id', itemId)
    if (forceEditId === invoiceId) await logChange(invoiceId, 'item_price', String(oldPrice), String(unitPrice))
    const newItems = (inv!.items || []).map(it => it.id === itemId ? { ...it, unit_price: unitPrice, total: newTotal } : it)
    const newSubtotal = newItems.reduce((s, it) => s + it.total, 0)
    const taxAmt = newSubtotal * (inv!.tax_rate || 0) / 100
    const newTotalAmt = Math.max(0, newSubtotal + taxAmt - (inv!.discount_amount || 0) + (inv!.previous_balance || 0))
    await supabase.from('invoices').update({ subtotal: newSubtotal, tax_amount: taxAmt, total_amount: newTotalAmt }).eq('id', invoiceId)
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, items: newItems, subtotal: newSubtotal, tax_amount: taxAmt, total_amount: newTotalAmt }
      : i
    ))
  }

  async function addManualItem(invoiceId: string, description: string, unitPrice: number) {
    if (!description.trim() || unitPrice <= 0) return
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    const displayOrder = (inv.items?.length || 0)
    const { data: newItem } = await supabase.from('invoice_items').insert({
      invoice_id: invoiceId, description, quantity: 1, unit_price: unitPrice,
      total: unitPrice, currency: inv.currency, display_order: displayOrder,
    }).select().single()
    if (!newItem) return
    const newItems = [...(inv.items || []), newItem]
    const newSubtotal = newItems.reduce((s, it) => s + it.total, 0)
    const taxAmt = newSubtotal * (inv.tax_rate || 0) / 100
    const newTotalAmt = Math.max(0, newSubtotal + taxAmt - (inv.discount_amount || 0) + (inv.previous_balance || 0))
    await supabase.from('invoices').update({ subtotal: newSubtotal, tax_amount: taxAmt, total_amount: newTotalAmt }).eq('id', invoiceId)
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, items: newItems, subtotal: newSubtotal, tax_amount: taxAmt, total_amount: newTotalAmt }
      : i
    ))
    success('Item added')
  }

  // ── Safe edit unlock (with required reason) ───────────────────────────────
  function requestEditUnlock(invoiceId: string) {
    setEditReasonInput('')
    setEditReasonModal(invoiceId)
  }
  function confirmEditUnlock() {
    if (!editReasonInput.trim()) return
    setForceEditId(editReasonModal)
    setForceEditReason(editReasonInput.trim())
    setEditReasonModal(null)
    setEditReasonInput('')
  }
  function lockEdit() {
    setForceEditId(null)
    setForceEditReason('')
  }

  // ── Audit log helper ─────────────────────────────────────────────────────
  async function logChange(invoiceId: string, fieldName: string, oldValue: string, newValue: string) {
    if (!forceEditReason) return
    await supabase.from('invoice_change_logs').insert({
      invoice_id: invoiceId, field_name: fieldName,
      old_value: oldValue, new_value: newValue, reason: forceEditReason,
    })
  }

  async function loadChangeLogs(invoiceId: string) {
    setChangeLogsLoading(true)
    const { data } = await supabase.from('invoice_change_logs')
      .select('*').eq('invoice_id', invoiceId).order('changed_at', { ascending: false })
    setChangeLogs(data || [])
    setChangeLogsLoading(false)
    setShowChangeLogs(true)
  }

  // ── Discount calculator ──────────────────────────────────────────────────
  async function loadDiscountCalc(clientId: string, invoiceId: string) {
    setDiscountLoading(true)
    const [allInvRes, discLogRes] = await Promise.all([
      supabase.from('invoices').select('total_amount,paid_amount,status,id').eq('client_id', clientId),
      supabase.from('discount_logs').select('discount_amount,discount_percentage,created_at,reason').eq('client_id', clientId).order('created_at', { ascending: false }),
    ])
    const allInv     = allInvRes.data || []
    const discHistory = discLogRes.data || []
    const otherInv   = allInv.filter(i => i.id !== invoiceId)
    const totalBilled = otherInv.reduce((s, i) => s + (i.total_amount || 0), 0)
    const totalPaid   = otherInv.reduce((s, i) => s + (i.paid_amount  || 0), 0)
    const paymentRate = totalBilled > 0 ? totalPaid / totalBilled : 0
    const invoiceCount = otherInv.length
    const thisInv    = invoices.find(i => i.id === invoiceId)
    const thisTotal  = thisInv?.total_amount || 0
    const totalDiscGiven = discHistory.reduce((s, d) => s + (d.discount_amount || 0), 0)
    const avgInvoice = invoiceCount > 0 ? totalBilled / invoiceCount : 0

    // Suggestion formula
    const loyaltyPct  = Math.min(3, (totalBilled / 50000) * 0.5)        // up to 3% for high volume
    const paymentPct  = paymentRate >= 0.95 ? 2 : paymentRate >= 0.8 ? 1 : 0  // reward good payers
    const volumePct   = invoiceCount >= 20 ? 2 : invoiceCount >= 10 ? 1 : 0    // reward long clients
    const maxPct      = Math.min(15, loyaltyPct + paymentPct + volumePct) // cap at 15%
    const suggestedMax = (thisTotal * maxPct) / 100

    setDiscountCalc({
      totalBilled, totalPaid, paymentRate, invoiceCount, avgInvoice,
      totalDiscGiven, discHistory, thisTotal, maxPct, suggestedMax,
    })
    setDiscountLoading(false)
  }

  async function applyDiscount(invoiceId: string, clientId: string) {
    const amt = parseFloat(manualDiscount)
    if (!amt || amt <= 0) { toastError('Enter a discount amount'); return }

    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    const sub = inv.subtotal || inv.total_amount || 0
    const taxAmt = sub * (inv.tax_rate || 0) / 100
    const newTotal = Math.max(0, sub + taxAmt - amt + (inv.previous_balance || 0))

    await supabase.from('invoices').update({ discount_amount: amt, total_amount: newTotal }).eq('id', invoiceId)
    // Log discount (reason optional)
    await supabase.from('discount_logs').insert({
      invoice_id: invoiceId, client_id: clientId, discount_amount: amt,
      discount_percentage: sub > 0 ? (amt / sub) * 100 : 0,
      invoice_total: inv.total_amount, reason: discountReason || 'No reason provided',
    })
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, discount_amount: amt, total_amount: newTotal, total_amount_inr: round2(newTotal * (i.exchange_rate || 1)) }
      : i
    ))
    success(`Discount of ${fmt(amt)} applied`)
    setManualDiscount(''); setDiscountReason('')
    // Keep discount section open so user can see the result
  }

  // ── Auto previous balance ────────────────────────────────────────────────
  async function autoLoadPrevBalance(invoiceId: string, clientId: string) {
    const { data } = await supabase.from('invoices')
      .select('total_amount,paid_amount,status')
      .eq('client_id', clientId)
      .in('status', ['sent','partial','overdue'])
      .neq('id', invoiceId)
    const pending = (data || []).reduce((s, i) => s + Math.max(0, (i.total_amount || 0) - (i.paid_amount || 0)), 0)
    if (pending <= 0) { toastError('No pending balance found from previous invoices'); return }
    await updatePreviousBalance(invoiceId, pending)
    success(`Previous balance ₹${pending.toFixed(2)} added from ${data!.length} invoice(s)`)
  }

  async function updatePreviousBalance(invoiceId: string, prevBal: number) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    const sub = inv.subtotal || inv.total_amount || 0
    const taxAmt = sub * (inv.tax_rate || 0) / 100
    const total = Math.max(0, sub + taxAmt - (inv.discount_amount || 0) + prevBal)
    await supabase.from('invoices').update({
      previous_balance: prevBal, total_amount: total, updated_at: new Date().toISOString(),
    }).eq('id', invoiceId)
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, previous_balance: prevBal, total_amount: total }
      : i
    ))
  }

  async function updateDiscount(invoiceId: string, discount: number) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    const sub = inv.subtotal || 0
    const taxAmt = sub * (inv.tax_rate || 0) / 100
    const total = Math.max(0, sub + taxAmt - discount + (inv.previous_balance || 0))
    await supabase.from('invoices').update({
      discount_amount: discount, total_amount: total, updated_at: new Date().toISOString(),
    }).eq('id', invoiceId)
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, discount_amount: discount, total_amount: total, total_amount_inr: round2(total * (i.exchange_rate || 1)) }
      : i
    ))
  }

  async function removeDiscountLog(logId: string, invoiceId: string) {
    await supabase.from('discount_logs').delete().eq('id', logId)
    const inv = invoices.find(i => i.id === invoiceId)
    if (inv) {
      const sub = inv.subtotal || 0
      const taxAmt = sub * (inv.tax_rate || 0) / 100
      const newTotal = Math.max(0, sub + taxAmt + (inv.previous_balance || 0))
      await supabase.from('invoices')
        .update({ discount_amount: 0, total_amount: newTotal, updated_at: new Date().toISOString() })
        .eq('id', invoiceId)
      setInvoices(prev => prev.map(i => i.id === invoiceId
        ? { ...i, discount_amount: 0, total_amount: newTotal, total_amount_inr: round2(newTotal * (i.exchange_rate || 1)) }
        : i
      ))
    }
    setDiscAnalytics(prev => prev.filter((d: any) => d.id !== logId))
  }

  // Derive { rate, amountInr, rateSource } for a foreign amount set
  // programmatically (quick-amount buttons, opening the panel). Preserves an
  // existing manual rate when one is supplied.
  function payFx(amountStr: string, currency: Currency, currentRate?: string): { rate: string; amountInr: string; rateSource: RateSource } {
    if (currency === 'INR') return { rate: '1', amountInr: amountStr, rateSource: 'manual' }
    const hasManual = currentRate !== undefined && currentRate !== '' && (parseFloat(currentRate) || 0) > 0
    const r = hasManual ? parseFloat(currentRate as string) : rateMap[currency]
    const rate = r ? String(r) : ''
    const amountInr = amountStr === '' ? '' : String(round2((parseFloat(amountStr) || 0) * (parseFloat(rate) || 0)))
    return { rate, amountInr, rateSource: hasManual ? 'manual' : (r ? 'settings' : 'manual') }
  }

  // Open the pay panel with the payment currency defaulted to the invoice's.
  function openPayPanel(inv: Invoice) {

    const cur = (inv.currency || 'INR') as Currency
    const fx = payFx('', cur)
    setPayForm(p => ({ ...p, amount: '', currency: cur, rate: fx.rate, amountInr: '', rateSource: fx.rateSource }))
    setIsAdvancePayment(false)
    setPanelMode('pay')
  }

  async function handlePayment(invoiceId: string) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    const foreign = parseFloat(payForm.amount) || 0
    if (foreign <= 0) { toastError('Enter a valid amount'); return }
    setSaving(true)

    // Everything below runs inside try/finally: if the server action rejects
    // (500, stale action id after a redeploy, dropped connection) the button
    // must not stay stuck on "Saving…" with no explanation.
    try {
      // FX captured for this payment.
      const isBase = payForm.currency === 'INR'
      const rate = isBase ? 1 : (parseFloat(payForm.rate) || rateMap[payForm.currency] || 1)
      const amountInr = isBase ? foreign : (parseFloat(payForm.amountInr) || round2(foreign * rate))
      const rateSource = isBase ? 'manual' : payForm.rateSource
      const rateDate = payForm.payment_date

      // Amount applied to the invoice's outstanding balance, in the INVOICE
      // currency. Usually the payment IS in the invoice currency (1:1); for a
      // cross-currency payment we pivot through INR using the invoice's own rate.
      const invRate = (inv.exchange_rate && inv.exchange_rate > 0) ? inv.exchange_rate : (rateMap[inv.currency] || 1)
      const appliedInvoiceCcy = payForm.currency === inv.currency ? foreign : round2(amountInr / (invRate || 1))

      const noteText = [
        isAdvancePayment ? '[ADVANCE PAYMENT]' : null,
        payForm.notes || null,
      ].filter(Boolean).join(' — ') || null

      const newPaid = round2((inv.paid_amount || 0) + appliedInvoiceCcy)  // invoice currency
      const newPaidInr = round2((inv.paid_amount_inr || 0) + amountInr)   // INR base
      const balance = (inv.total_amount || 0) - newPaid
      const newStatus = balance <= 0 ? 'paid' : 'partial'

      // Find the invoice category
      const invoiceCategoryId = cashbookCategories?.find(c => c.name.toLowerCase().includes('invoice'))?.id || null

      // Call server action — records payment + creates cashbook inflow entry atomically
      const res = await recordInvoicePayment({
        invoiceId,
        invoiceNumber:  inv.invoice_number,
        clientId:       inv.client_id || null,
        clientCode:     inv.client?.code || null,
        clientName:     inv.client?.name || null,
        amount:         foreign,
        currency:       payForm.currency,
        amountInr,
        exchangeRate:   rate,
        rateSource,
        rateDate,
        paymentDate:    payForm.payment_date,
        paymentMethod:  payForm.payment_method,
        reference:      payForm.reference || null,
        notes:          noteText,
        bankAccountId:  payForm.bank_account_id || null,
        newPaid,
        newPaidInr,
        newStatus,
        appliedInvoiceCcy: appliedInvoiceCcy,   // delta for atomic server-side increment
        appliedInr:        amountInr,
        categoryId:     invoiceCategoryId,
      })

      if (!res.ok) { toastError(res.error ?? 'Payment failed'); return }

      // Build a synthetic payment object for optimistic UI update
      const pmt: Payment = {
        id: res.data!.paymentId,
        amount: foreign,
        currency: payForm.currency,
        exchange_rate: rate,
        amount_inr: amountInr,
        rate_source: rateSource as any,
        rate_date: rateDate,
        payment_date: payForm.payment_date,
        payment_method: payForm.payment_method,
        reference: payForm.reference || undefined,
        notes: noteText ?? undefined,
        receipt_number: res.data!.receiptNumber,
        bank_account_name: bankAccounts.find(b => b.id === payForm.bank_account_id)?.name ?? null,
      }

      setInvoices(prev => prev.map(i => i.id === invoiceId
        ? { ...i, paid_amount: newPaid, paid_amount_inr: newPaidInr, status: newStatus, payments: [...(i.payments || []), pmt] }
        : i
      ))
      const label = isAdvancePayment ? `Advance ${fmt(foreign, payForm.currency)} recorded` : `Payment of ${fmt(foreign, payForm.currency)} recorded — added to Cashbook`
      success(label)
      setPayForm({ amount: '', currency: (inv.currency || 'INR') as Currency, rate: '', amountInr: '', rateSource: 'settings', payment_date: todayISO(), payment_method: 'bank_transfer', reference: '', notes: '', bank_account_id: defaultBankAccountId })
      setIsAdvancePayment(false)
      setPanelMode('detail')
    } catch (err: any) {
      // The payment MAY have landed server-side before the transport failed, so
      // tell the user to re-check rather than blindly retrying.
      console.error('[handlePayment] failed:', err)
      toastError(
        'Payment failed',
        `${err?.message || 'Could not reach the server'} — not confirmed. Reload and check the invoice before retrying.`,
      )
    } finally {
      setSaving(false)
    }
  }

  // Reverse the auto-created cashbook inflow + allocation for a single payment.
  // Matches on invoice + inflow type + payment date AND amount so that when an
  // invoice has two same-day payments, removing one never deletes the other's
  // cashbook entry. Returns true if an entry was removed.
  async function reverseInvoicePaymentCashbook(
    invoiceId: string,
    pmt: { payment_date?: string; amount_inr?: number; amount?: number },
  ): Promise<boolean> {
    const { data: allocRows } = await supabase
      .from('cashbook_invoice_allocations')
      .select('cashbook_entry_id, cashbook_entries!inner(entry_date, type, amount_inr, amount)')
      .eq('invoice_id', invoiceId)
    if (!allocRows || allocRows.length === 0) return false
    const targetInr = round2(pmt.amount_inr ?? pmt.amount ?? 0)
    const candidates = (allocRows as any[]).filter(
      r => r.cashbook_entries?.type === 'inflow' && r.cashbook_entries?.entry_date === pmt.payment_date,
    )
    // Prefer an amount match; fall back to the single date+type match if only one.
    const matchEntry =
      candidates.find(r => round2(r.cashbook_entries?.amount_inr ?? r.cashbook_entries?.amount ?? 0) === targetInr) ??
      (candidates.length === 1 ? candidates[0] : undefined)
    if (!matchEntry) return false
    await supabase.from('cashbook_invoice_allocations').delete().eq('cashbook_entry_id', matchEntry.cashbook_entry_id)
    await supabase.from('cashbook_entries').delete().eq('id', matchEntry.cashbook_entry_id)
    return true
  }

  async function deletePayment(invoiceId: string, paymentId: string) {
    toastError('Payments cannot be deleted directly. Manage allocations via the Cash Book.')
  }

  async function handleResync(invoiceId: string) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv || inv.status !== 'draft') return
    setSaving(true)
    setResyncingId(invoiceId)
    try {
      const result = await serverResyncInvoiceTasks(inv.id)
      if (!result.ok) throw new Error(result.error)
      const fees = result.data?.feeLines || 0
      success(
        `Processed ${result.data?.syncedTasks || 0} tasks`
          + (fees > 0 ? ` and ${fees} package line${fees === 1 ? '' : 's'}` : '') + '.',
        `Invoice resynced`,
      )
      // Refresh list to pull updated items
      router.refresh()
    } catch (e: any) {
      toastError(e.message || 'Failed to resync invoice')
    } finally {
      setSaving(false)
      setResyncingId(null)
    }
  }

  // Bulk resync: only draft invoices can be resynced (server action enforces it
  // too), so silently skip non-drafts rather than failing the whole batch.
  // Runs sequentially — each resync rewrites line items and package fee lines,
  // and firing them in parallel races the per-invoice package-line upserts.
  async function handleBulkResync() {
    if (selectedForBulk.size === 0) return
    const targets = invoices.filter(i => selectedForBulk.has(i.id) && i.status === 'draft')
    const skipped = selectedForBulk.size - targets.length
    if (!targets.length) {
      toastError('No draft invoices selected. Only drafts can be resynced.')
      return
    }
    setSaving(true)
    setIsUpdatingBulk(true)
    let okCount = 0, taskCount = 0, feeCount = 0
    const failures: string[] = []
    try {
      for (const inv of targets) {
        setResyncingId(inv.id)
        try {
          const result = await serverResyncInvoiceTasks(inv.id)
          if (!result.ok) throw new Error(result.error)
          okCount++
          taskCount += result.data?.syncedTasks || 0
          feeCount += result.data?.feeLines || 0
        } catch (e: any) {
          failures.push(`${inv.invoice_number || inv.id}: ${e.message || 'failed'}`)
        }
      }
      if (okCount > 0) {
        success(
          `Processed ${taskCount} task${taskCount === 1 ? '' : 's'}`
            + (feeCount > 0 ? ` and ${feeCount} package line${feeCount === 1 ? '' : 's'}` : '')
            + (skipped > 0 ? ` · ${skipped} non-draft skipped` : ''),
          `${okCount} invoice${okCount === 1 ? '' : 's'} resynced`,
        )
      }
      if (failures.length) {
        toastError(`${failures.length} invoice${failures.length === 1 ? '' : 's'} failed: ${failures.slice(0, 3).join('; ')}`)
      }
      router.refresh()
    } finally {
      setResyncingId(null)
      setSaving(false)
      setIsUpdatingBulk(false)
    }
  }

  function confirmDelete(invoiceId: string) {
    const inv = invoices.find(i => i.id === invoiceId)
    if (inv && ((inv.paid_amount && inv.paid_amount > 0) || (inv.payments && inv.payments.length > 0) || (inv.status === 'paid' || inv.status === 'partial'))) {
      toastError(`Invoice has recorded payments and cannot be deleted. Cancel it or reverse the payments first.`)
      return
    }
    setConfirmModal({
      title: 'Delete Invoice',
      body: `Delete ${inv?.invoice_number ?? 'this invoice'}? This cannot be undone and will revert any linked tasks back to "Done".`,
      confirmLabel: 'Delete Invoice',
      danger: true,
      onConfirm: () => deleteInvoice(invoiceId),
    })
  }

  async function deleteInvoice(invoiceId: string) {
    setConfirmModal(null)
    setDeleting(true)
    try {
      // Detail must be loaded first: without it `items` is undefined and the
      // linked tasks stay 'invoiced' against an invoice that no longer exists.
      const [inv] = await ensureDetails([invoiceId])
      const taskIds = (inv?.items || []).map(it => it.task_id).filter(Boolean) as string[]
      if (taskIds.length) await supabase.from('tasks').update({ status: 'done' }).in('id', taskIds)
      await supabase.from('cashbook_invoice_allocations').delete().eq('invoice_id', invoiceId)
      await supabase.from('invoice_items').delete().eq('invoice_id', invoiceId)
      const { error } = await supabase.from('invoices').delete().eq('id', invoiceId)
      if (error) { toastError(error.message); return }
      setInvoices(prev => prev.filter(i => i.id !== invoiceId))
      if (selectedId === invoiceId) setSelectedId(null)
      success('Invoice deleted')
    } finally {
      setDeleting(false)
    }
  }

  // ── Bulk Status Update ─────────────────────────────────────────────────────
  async function handleBulkLogFollowup() {
    if (selectedForBulk.size === 0) return;
    setIsUpdatingBulk(true);
    const ids = Array.from(selectedForBulk);
    try {
      for (const id of ids) {
        await logFollowup({
          invoiceId: id,
          note: "Bulk reminder sent",
          outcome: "Awaiting response",
        });
      }
      alert("Follow-up logged for " + ids.length + " invoices.");
      setSelectedForBulk(new Set());
    } catch (e: any) {
      alert("Error logging follow-up: " + e.message);
    } finally {
      setIsUpdatingBulk(false);
    }
  }

  async function handleBulkStatusUpdate(newStatus: string) {
    if (selectedForBulk.size === 0) return
    setIsUpdatingBulk(true)

    const idsToUpdate = Array.from(selectedForBulk)

    // NOTE: invoices has no `sent_at` column (only `updated_at`) — writing
    // sent_at 400s the whole batch, which is why bulk Mark Sent never worked.
    const baseUpdates: any = { status: newStatus, updated_at: new Date().toISOString() }

    // For 'sent', auto-fill a due date on any selected invoice that lacks one —
    // net-30 from each invoice's own ISSUE date (not "today"), so back-dated
    // invoices get a correct (possibly already-overdue) due date. Because each
    // invoice can have a different issue date, these are written one-by-one;
    // the rest go out in a single batched update.
    const dueById = new Map<string, string>()
    let missingDueIds: string[] = []
    if (newStatus === 'sent') {
      const missing = invoices.filter(i => idsToUpdate.includes(i.id) && !i.due_date)
      missingDueIds = missing.map(i => i.id)
      for (const inv of missing) {
        dueById.set(inv.id, addDaysISO(inv.issue_date || todayISO(), 30))
      }
    }

    let error: { message: string } | null = null
    for (const [id, dueStr] of dueById) {
      if (error) break
      const r = await supabase.from('invoices').update({ ...baseUpdates, due_date: dueStr }).eq('id', id)
      error = r.error
    }
    const remainingIds = idsToUpdate.filter(id => !missingDueIds.includes(id))
    if (!error && remainingIds.length) {
      const r = await supabase.from('invoices').update(baseUpdates).in('id', remainingIds)
      error = r.error
    }

    if (error) {
      toastError(error.message)
    } else {
      // Mirror the single-invoice task-status sync that the bulk path was missing.
      // When bulk-marking sent → tasks become 'invoiced'; draft/cancelled → revert to 'done'.
      const bulkTaskStatus = newStatus === 'sent' ? 'invoiced' : (newStatus === 'draft' || newStatus === 'cancelled') ? 'done' : null
      if (bulkTaskStatus) {
        // Same reason as deleteInvoice — read the rows ensureDetails returns,
        // not `invoices`, which React has not re-rendered yet.
        const withItems = await ensureDetails(idsToUpdate)
        const taskIds = withItems
          .flatMap(i => (i.items || []).map((it: any) => it.task_id).filter(Boolean)) as string[]
        if (taskIds.length) {
          await supabase.from('tasks').update({ status: bulkTaskStatus }).in('id', taskIds)
        }
      }

      setInvoices(prev => prev.map(i => {
        if (!idsToUpdate.includes(i.id)) return i
        const patch: any = { ...baseUpdates }
        const dd = dueById.get(i.id)
        if (dd) patch.due_date = dd
        return { ...i, ...patch }
      }))
      setSelectedForBulk(new Set())
      success(
        `Updated ${idsToUpdate.length} invoice(s) to ${newStatus}`,
        missingDueIds.length ? `${missingDueIds.length} due date(s) set to net-30 from issue date` : undefined,
      )
    }
    setIsUpdatingBulk(false)
  }
  
  function toggleBulkSelection(e: React.MouseEvent, id: string) {
    e.stopPropagation()
    setSelectedForBulk(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Cancel reuses the same status-update path as Mark Reviewed/Mark Sent above
  // (handleBulkStatusUpdate already handles the due-date + linked-task-status
  // side effects per status) — just a new target status, not a new mechanism.
  function handleBulkCancel() {
    void handleBulkStatusUpdate('cancelled')
  }

  // Export the CURRENT SELECTION as a CSV (distinct from the existing
  // statement exporter, which exports a date-range/single-client ledger —
  // this is just "what I've got selected right now").
  function exportSelectedCSV() {
    if (selectedForBulk.size === 0) return
    const esc = (v: any) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const rows = invoices.filter(i => selectedForBulk.has(i.id))
    const header = ['Invoice #', 'Client', 'Issue Date', 'Due Date', 'Status', 'Total', 'Paid', 'Balance', 'Currency']
    const lines = [header.join(',')]
    for (const inv of rows) {
      const balance = Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0))
      lines.push([
        inv.invoice_number, inv.client?.name || '', inv.issue_date || '', inv.due_date || '',
        getStatusLabel(inv.status), inv.total_amount || 0, inv.paid_amount || 0, balance, inv.currency || 'INR',
      ].map(esc).join(','))
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.setAttribute('download', `invoices_export_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  // Generate an all-time statement for each DISTINCT client among the
  // current selection — reuses printStatement(overrideClientId) (the exact
  // same generator the single-client "Generate Statement" modal uses) rather
  // than building a second statement renderer. One print tab per client.
  // Hands off to the Statements page rather than generating here. A statement
  // is a running ledger — it needs the client's FULL history for its opening
  // balance, which this page deliberately no longer loads. With one client in
  // the selection it opens pre-selected; with several, it opens on the picker.
  function generateStatementsForSelected() {
    if (selectedForBulk.size === 0) return
    const clientIds = [...new Set(invoices.filter(i => selectedForBulk.has(i.id)).map(i => i.client_id).filter(Boolean))] as string[]
    router.push(clientIds.length === 1
      ? `/dashboard/statements?client=${clientIds[0]}`
      : '/dashboard/statements')
  }

  function toggleSelectAllBulk() {
    const visibleIds = filtered.map(i => i.id)
    setSelectedForBulk(prev => {
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id))
      const next = new Set(prev)
      if (allSelected) {
        visibleIds.forEach(id => next.delete(id))
      } else {
        visibleIds.forEach(id => next.add(id))
      }
      return next
    })
  }

  // Keep ref in sync so Cmd+S can call it
  const createManualInvoice = useCallback(async function createManualInvoiceImpl() {
    if (!newForm.client_id) { toastError('Select a client'); return }
    // Block non-INR invoices when no Settings rate exists — otherwise the rate is
    // silently snapshotted as 1.0, making total_amount_inr and realised FX wrong.
    if (newForm.currency !== 'INR' && !(rateMap[newForm.currency] > 0)) {
      toastError(`No exchange rate for ${newForm.currency}. Add it in Settings → Exchange Rates before invoicing in ${newForm.currency}.`)
      return
    }
    setSaving(true)
    try {
      const client = clients.find(c => c.id === newForm.client_id)
      const clientCode = client?.code || 'CLI'
      const invoiceDate = new Date(newForm.issue_date)
      const { invoiceNumber: invNum, sequenceMonth } =
        await generateInvoiceNumber(supabase, invoiceDate, clientCode)

      const validItems = newForm.items.filter(it => it.description.trim())
      const subtotal = validItems.reduce((s, it) => s + it.total, 0)

      // Base insert with columns that always exist
      const { data: inv, error } = await supabase.from('invoices').insert({
        invoice_number: invNum, client_id: newForm.client_id, status: 'draft',
        issue_date: newForm.issue_date,
        due_date: newForm.due_date || addDaysISO(newForm.issue_date || todayISO(), 30),
        currency: newForm.currency, total_amount: subtotal, paid_amount: 0,
        notes: newForm.notes || null,
      }).select('*, client:clients(id,name,code,phone,email)').single()

      if (error) { toastError(error.message); return }

      // Update extended columns if migration has been run (silently ignored if not)
      await supabase.from('invoices').update({
        subtotal, tax_rate: 0, tax_amount: 0, discount_amount: 0, previous_balance: 0,
        invoice_sequence_month: sequenceMonth,
        exchange_rate: creationRate(newForm.currency), paid_amount_inr: 0,
      }).eq('id', inv.id)

      if (validItems.length) {
        await supabase.from('invoice_items').insert(
          validItems.map((it, idx) => ({
            invoice_id: inv.id, description: it.description, service_id: it.service_id || null,
            quantity: it.quantity, unit_price: it.unit_price, total: it.total,
            currency: newForm.currency, display_order: idx,
          }))
        )
      }
      const { data: full } = await supabase.from('invoices')
        .select('*, client:clients(id,name,code), items:invoice_items(*, service:services(id,name)), payments(*)')
        .eq('id', inv.id).single()

      setInvoices(prev => [full as any, ...prev])
      setSelectedId(inv.id)
      setPanelMode('detail')
      setNewForm({ client_id: '', currency: 'INR', issue_date: todayISO(), due_date: '', notes: '', items: [{ description: '', quantity: 1, unit_price: 0, total: 0, service_id: '' }] })
      success('Invoice created')
    } finally {
      setSaving(false)
    }
  }, [newForm, clients, invoices, services, saving, toastError, success, supabase, setInvoices, setPanelMode, setNewForm, setSaving])

  useEffect(() => { createManualInvoiceRef.current = createManualInvoice }, [createManualInvoice])

  // ── Generate invoice from date range ──────────────────────────────────────
  async function fetchGenTasks() {
    if (!genForm.client_id) { toastError('Select a client'); return }
    setGenLoading(true); setGenTasks([]); setGenSelectedIds(new Set())
    const from = genForm.mode === 'day' ? genForm.specific_date : genForm.date_from
    const to   = genForm.mode === 'day' ? genForm.specific_date : genForm.date_to

    // Fetch done AND invoiced tasks in range (so we can warn about already-invoiced ones)
    const { data: rawTasks } = await supabase
      .from('tasks')
      .select('id, title, task_date, billing_amount, billing_amount_inr, currency, status, quantity, unit_price, service:services!service_id(name)')
      .eq('client_id', genForm.client_id)
      // Waived work is delivered and paid for internally, but never charged —
      // see lib/tasks/billable.ts. `not.is.false` keeps the pre-flag rows.
      .not('is_billable', 'is', false)
      .in('status', ['done', 'invoiced'])
      .gte('task_date', from)
      .lte('task_date', to)
      .order('task_date')

    if (!rawTasks?.length) { setGenTasks([]); setGenLoading(false); return }

    // Check which tasks are already in invoice_items
    const taskIds = rawTasks.map((t: any) => t.id)
    const { data: existingItems } = await supabase
      .from('invoice_items')
      .select('task_id, invoice:invoices(id, invoice_number, status)')
      .in('task_id', taskIds)

    // Build task_id → invoices[] map
    const taskInvMap: Record<string, { id: string; invoice_number: string; status: string }[]> = {}
    ;(existingItems || []).forEach((item: any) => {
      if (item.task_id && item.invoice) {
        if (!taskInvMap[item.task_id]) taskInvMap[item.task_id] = []
        taskInvMap[item.task_id].push(item.invoice)
      }
    })

    const enriched = rawTasks.map((t: any) => ({
      ...t,
      existing_invoices: taskInvMap[t.id] || [],
    }))

    setGenTasks(enriched)
    // Auto-select only tasks NOT already in an active invoice
    const safeIds = enriched
      .filter((t: any) => t.existing_invoices.length === 0 || t.existing_invoices.every((inv: any) => inv.status === 'cancelled'))
      .map((t: any) => t.id)
    setGenSelectedIds(new Set(safeIds))
    setGenLoading(false)
  }

  async function createFromGenTasks() {
    const selected = genTasks.filter(t => genSelectedIds.has(t.id))
    if (!selected.length) { toastError('No tasks selected'); return }
    setSaving(true)
    try {
      const client = clients.find(c => c.id === genForm.client_id)
      const clientCode = client?.code || 'CLI'

      // Billing month = the EARLIEST selected task's own task_date, month-truncated
      // — same convention buildBillingPeriod/the task-done trigger use everywhere
      // else. Previously this used the raw (unstruncated) date-range `from` filter
      // value as billing_period_start, which could land on any day of the month
      // and never match the month-truncated value the trigger writes — silently
      // producing a SECOND draft for a month that already had one.
      const earliestDate = selected.reduce((min, t) => (t.task_date && t.task_date < min ? t.task_date : min), selected[0].task_date || todayISO())
      const taskMonth = earliestDate.slice(0, 7)
      const billingPeriod = buildBillingPeriod(taskMonth)
      const invoiceDate = getInvoiceDateForTaskMonth(taskMonth)

      // Customer invoices bill in the task's OWN currency, so line amounts come
      // from billing_amount (foreign), NOT billing_amount_inr (the internal INR
      // base used only for contributions/payroll/analytics). Fallback keeps
      // legacy rows that only have the INR column working.
      const taskAmt = (t: any) => t.billing_amount ?? t.billing_amount_inr ?? 0
      // Invoice currency follows the tasks (line amounts are in each task's OWN
      // currency via billing_amount), not client.default_currency — which can be
      // unset/stale and would mislabel foreign amounts (e.g. AED) as ₹.
      const invCurrency = selected.find(t => t.currency)?.currency || client?.default_currency || 'INR'

      // One draft per client per billing month — check for an existing draft
      // covering this exact month before creating a new invoice, so re-running
      // Generate for a month that already has an open draft appends to it
      // instead of opening a duplicate.
      const { data: existingDraft } = await supabase
        .from('invoices')
        .select('id, discount_amount, tax_amount, previous_balance, currency')
        .eq('client_id', genForm.client_id)
        .eq('status', 'draft')
        .eq('billing_period_start', billingPeriod.billing_period_start)
        .maybeSingle()

      let invId: string
      let invNum = ''
      let orderOffset = 0

      if (existingDraft && existingDraft.currency === invCurrency) {
        invId = existingDraft.id
        const { count } = await supabase.from('invoice_items').select('id', { count: 'exact', head: true }).eq('invoice_id', invId)
        orderOffset = count || 0
      } else {
        const { invoiceNumber, sequenceMonth } = await generateInvoiceNumber(supabase, invoiceDate, clientCode)
        invNum = invoiceNumber
        const { data: created, error } = await supabase.from('invoices').insert({
          invoice_number: invNum, client_id: genForm.client_id, status: 'draft',
          issue_date: formatLocalDate(invoiceDate),
          total_amount: 0, paid_amount: 0,
          currency: invCurrency,
        }).select('id').single()

        if (error || !created) { toastError(error?.message || 'Failed to create invoice'); return }
        invId = created.id

        await supabase.from('invoices').update({
          billing_period_start: billingPeriod.billing_period_start,
          billing_period_end: billingPeriod.billing_period_end,
          billing_period_label: billingPeriod.billing_period_label,
          tax_rate: 0, tax_amount: 0, discount_amount: 0, previous_balance: 0,
          invoice_sequence_month: sequenceMonth,
          exchange_rate: creationRate(invCurrency), paid_amount_inr: 0,
        }).eq('id', invId)
      }

      await supabase.from('invoice_items').insert(
        selected.map((t, idx) => {
          const qty = Number(t.quantity ?? 1)
          const total = taskAmt(t)
          const unit_price = total ? (total / qty) : 0
          return {
            invoice_id: invId, task_id: t.id,
            description: t.title, quantity: qty,
            unit_price: unit_price, total: total,
            currency: t.currency || 'INR', display_order: orderOffset + idx,
          }
        })
      )

      // Recompute totals from the actual rows now on the invoice (correct whether
      // this was a fresh invoice or an existing draft we just appended to).
      const [{ data: itemRows }, { data: expRows }] = await Promise.all([
        supabase.from('invoice_items').select('total').eq('invoice_id', invId),
        supabase.from('invoice_expense_items').select('amount').eq('invoice_id', invId),
      ])
      const subtotal = (itemRows || []).reduce((s, r) => s + (r.total || 0), 0) + (expRows || []).reduce((s, r) => s + (r.amount || 0), 0)
      const discount = existingDraft?.discount_amount || 0
      const tax = existingDraft?.tax_amount || 0
      const prevBalance = existingDraft?.previous_balance || 0
      const totalAmount = round2(subtotal - discount + tax + prevBalance)
      await supabase.from('invoices').update({ subtotal, total_amount: totalAmount, updated_at: new Date().toISOString() }).eq('id', invId)

      const { data: full } = await supabase.from('invoices')
        .select('*, client:clients(id,name,code,phone,email,address), items:invoice_items(*, task:tasks(id,title,task_date,status,billing_amount_inr,currency), service:services(id,name)), payments(*)')
        .eq('id', invId).single()

      const fullInv = full as any
      setInvoices(prev => existingDraft
        ? prev.map(i => i.id === invId ? fullInv : i)
        : [fullInv, ...prev])
      setSelectedId(invId); setPanelMode('detail')
      setGenTasks([]); setGenSelectedIds(new Set())
      success(existingDraft
        ? `${selected.length} item${selected.length !== 1 ? 's' : ''} added to existing draft ${full?.invoice_number}`
        : `Invoice ${invNum} created with ${selected.length} items`)
    } finally {
      setSaving(false)
    }
  }

  // ── Batch historical invoice generation ──────────────────────────────────
  async function fetchBatchGroups() {
    setBatchLoading(true); setBatchGroups([]); setBatchSelected(new Set()); setBatchDone(0); setBatchExpandedKey(null)

    // Probe whether soft-delete column exists so we can exclude trashed tasks
    const probe = await supabase.from('tasks').select('deleted_at').limit(0)
    const hasSoftDelete = !probe.error

    // Fetch ALL done tasks with pagination — Supabase caps each response at 1000 rows,
    // so we page with .range() in 1000-row chunks until we get a partial page.
    const PAGE = 1000
    const doneTasks: any[] = []
    for (let page = 0; page < 50; page++) {
      let q = supabase
        .from('tasks')
        .select('id, title, task_date, billing_amount, billing_amount_inr, currency, client_id, client:clients(id, name, code, default_currency)')
        .eq('status', 'done')
        .not('is_billable', 'is', false)      // waived work never reaches an invoice
        .order('task_date')
        .range(page * PAGE, (page + 1) * PAGE - 1)
      if (hasSoftDelete) q = q.is('deleted_at', null)
      const { data, error } = await q
      if (error || !data) break
      doneTasks.push(...data)
      if (data.length < PAGE) break   // last page reached
    }
    if (!doneTasks.length) { setBatchLoading(false); return }

    // Find which ones are already in active invoices
    const taskIds = doneTasks.map((t: any) => t.id)
    // Supabase also caps .in() results at 1000 — chunk the taskIds lookup
    const CHUNK = 500
    const allExistingItems: any[] = []
    for (let i = 0; i < taskIds.length; i += CHUNK) {
      const { data } = await supabase
        .from('invoice_items')
        .select('task_id, invoice:invoices(id, status)')
        .in('task_id', taskIds.slice(i, i + CHUNK))
      if (data) allExistingItems.push(...data)
    }

    const invoicedTaskIds = new Set<string>()
    ;(allExistingItems || []).forEach((item: any) => {
      if (item.task_id && item.invoice && item.invoice.status !== 'cancelled') {
        invoicedTaskIds.add(item.task_id)
      }
    })

    // Filter to only un-invoiced tasks
    const uninvoiced = doneTasks.filter((t: any) => !invoicedTaskIds.has(t.id))

    // Group by client + month — store full task objects for preview
    type BatchGroup = typeof batchGroups[0]
    const groupMap: Record<string, BatchGroup & { tasks: NonNullable<BatchGroup['tasks']> }> = {}
    uninvoiced.forEach((t: any) => {
      const clientId = t.client_id || t.client?.id
      // Internal work (client_id NULL) is Cirqle's own — it must never be
      // swept into an invoice. Without this guard these tasks would group
      // under an undefined client and generate a client-less invoice.
      if (!clientId) return
      const clientName = t.client?.name || 'Unknown'
      const clientCode = t.client?.code || 'CLI'
      const month = t.task_date ? t.task_date.slice(0, 7) : 'unknown'
      const key = `${clientId}__${month}`
      if (!groupMap[key]) {
        groupMap[key] = {
          key, client_id: clientId, client_name: clientName,
          client_code: clientCode, month, taskCount: 0, total: 0,
          // Invoice currency MUST match the currency the line amounts are in.
          // Amounts come from each task's billing_amount (its OWN currency), so
          // the invoice currency is driven by the task — NOT client.default_currency,
          // which can be unset/stale and would mislabel e.g. AED amounts as ₹.
          currency: t.currency || t.client?.default_currency || 'INR',
          taskIds: [], default_currency: t.client?.default_currency,
          tasks: [],
        }
      }
      groupMap[key].taskCount++
      // Bill in the task's own currency: use billing_amount (foreign), not the
      // internal INR base. Fallback keeps legacy INR-only rows working.
      const amt = t.billing_amount ?? t.billing_amount_inr ?? 0
      groupMap[key].total += amt
      groupMap[key].taskIds.push(t.id)
      groupMap[key].tasks.push({
        id: t.id, title: t.title,
        task_date: t.task_date, billing_amount_inr: amt,
        currency: t.currency || 'INR',
      })
    })

    const groups = Object.values(groupMap).sort((a, b) => {
      if (a.client_name < b.client_name) return -1
      if (a.client_name > b.client_name) return 1
      return a.month < b.month ? -1 : 1
    })

    // Fetch unbilled outflow expenses for all client IDs that appear in groups
    const uniqueClientIds = [...new Set(groups.map(g => g.client_id))]
    const { data: allExpEntries } = await supabase
      .from('cashbook_entries')
      .select('id, client_id, entry_date, description, amount_inr')
      .in('client_id', uniqueClientIds)
      .eq('type', 'outflow')
      .is('deleted_at', null)
    const expEntriesRaw = (allExpEntries || []) as { id: string; client_id: string; entry_date: string; description: string | null; amount_inr: number }[]
    // Find already-billed entries
    const { data: billedExpItems } = expEntriesRaw.length
      ? await supabase.from('invoice_expense_items').select('cashbook_entry_id, invoice:invoices(status)').in('cashbook_entry_id', expEntriesRaw.map(e => e.id))
      : { data: [] }
    const billedExpIds = new Set((billedExpItems || []).filter((b: any) => b.invoice?.status !== 'cancelled').map((b: any) => b.cashbook_entry_id))
    // Attach expenses to matching groups
    for (const g of groups) {
      const [yr, mo] = g.month.split('-').map(Number)
      const monthStart = g.month + '-01'
      const monthEnd = formatLocalDate(new Date(yr, mo, 0))
      g.expenses = expEntriesRaw.filter(e =>
        e.client_id === g.client_id &&
        !billedExpIds.has(e.id) &&
        e.entry_date >= monthStart &&
        e.entry_date <= monthEnd
      )
    }

    setBatchGroups(groups)
    setBatchSelected(new Set(groups.map(g => g.key)))
    setBatchLoading(false)
  }

  async function runBatchGenerate() {
    const toGenerate = batchGroups.filter(g => batchSelected.has(g.key))
    if (!toGenerate.length) { toastError('No groups selected'); return }
    setBatchGenerating(true); setBatchDone(0)
    let doneCount = 0; let errorCount = 0

    for (const group of toGenerate) {
      try {
        const invCurrency = group.currency || 'INR'
        const billingPeriod = buildBillingPeriod(group.month)

        // One draft per client per billing month — check for an existing draft
        // covering this exact month before creating a new invoice (mirrors the
        // same rule the task-done trigger already follows), so re-running Batch
        // Generate never opens a second invoice for a month that already has
        // an open draft.
        const { data: existingDraft } = await supabase
          .from('invoices')
          .select('id, discount_amount, tax_amount, previous_balance, currency')
          .eq('client_id', group.client_id)
          .eq('status', 'draft')
          .eq('billing_period_start', billingPeriod.billing_period_start)
          .maybeSingle()

        let invId: string
        let orderOffset = 0

        if (existingDraft && existingDraft.currency === invCurrency) {
          invId = existingDraft.id
          const { count } = await supabase.from('invoice_items').select('id', { count: 'exact', head: true }).eq('invoice_id', invId)
          orderOffset = count || 0
        } else {
          // Use proper billing cycle: tasks in Aug → invoice issued Sep 1
          const invoiceDate = getInvoiceDateForTaskMonth(group.month)
          const { invoiceNumber: invNum, sequenceMonth } =
            await generateInvoiceNumber(supabase, invoiceDate, group.client_code)

          const issueDateStr = formatLocalDate(invoiceDate)
          const dueDateObj = new Date(invoiceDate); dueDateObj.setDate(dueDateObj.getDate() + 30)
          const dueDateStr = formatLocalDate(dueDateObj)
          const { data: created, error } = await supabase.from('invoices').insert({
            invoice_number: invNum,
            client_id: group.client_id,
            status: 'draft',
            issue_date: issueDateStr,
            due_date: dueDateStr,
            total_amount: 0,
            paid_amount: 0,
            currency: invCurrency,
          }).select('id').single()

          if (error || !created) { errorCount++; continue }
          invId = created.id

          // Extended columns (ignore if not migrated)
          await supabase.from('invoices').update({
            billing_period_start: billingPeriod.billing_period_start,
            billing_period_end: billingPeriod.billing_period_end,
            billing_period_label: billingPeriod.billing_period_label,
            invoice_sequence_month: sequenceMonth,
            tax_rate: 0, tax_amount: 0, discount_amount: 0, previous_balance: 0,
            exchange_rate: creationRate(invCurrency), paid_amount_inr: 0,
          }).eq('id', invId)
        }

        // Fetch task details for items
        const { data: taskDetails } = await supabase
          .from('tasks')
          .select('id, title, billing_amount, billing_amount_inr, currency, quantity, unit_price')
          .in('id', group.taskIds)

        if (taskDetails?.length) {
          await supabase.from('invoice_items').insert(
            taskDetails.map((t: any, idx: number) => {
              const qty = Number(t.quantity ?? 1)
              const amt = t.billing_amount ?? t.billing_amount_inr ?? 0
              const unit_price = amt ? (amt / qty) : 0
              return {
                invoice_id: invId, task_id: t.id,
                description: t.title, quantity: qty,
                unit_price: unit_price, total: amt,
                currency: t.currency || 'INR', display_order: orderOffset + idx,
              }
            })
          )
        }
        // Auto-add unbilled client expense outflows for the same task month
        const [taskYr, taskMo] = group.month.split('-').map(Number)
        const monthStart = group.month + '-01'
        const monthEnd = lastDayOfMonthISO(taskYr, taskMo)
        const { data: expEntries } = await supabase
          .from('cashbook_entries')
          .select('id, amount_inr, description, currency, amount')
          .eq('client_id', group.client_id)
          .eq('type', 'outflow')
          .is('deleted_at', null)
          .gte('entry_date', monthStart)
          .lte('entry_date', monthEnd)
        if (expEntries?.length) {
          const { data: alreadyBilled } = await supabase
            .from('invoice_expense_items')
            .select('cashbook_entry_id, invoice:invoices(status)')
            .in('cashbook_entry_id', expEntries.map((e: any) => e.id))
          const billedIds = new Set(
            (alreadyBilled || []).filter((b: any) => b.invoice?.status !== 'cancelled').map((b: any) => b.cashbook_entry_id)
          )
          const toAddExp = expEntries.filter((e: any) => !billedIds.has(e.id))
          if (toAddExp.length) {
            const invCur = invCurrency
            const invRate = creationRate(invCur)
            const expRows = toAddExp.map((e: any) => {
              const amtInInvCur = invCur === 'INR' ? e.amount_inr : round2(e.amount_inr / (invRate || 1))
              return {
                invoice_id: invId,
                cashbook_entry_id: e.id,
                description: e.description || 'Expense',
                amount: amtInInvCur,
                amount_inr: e.amount_inr,
                currency: invCur,
                original_amount: amtInInvCur,
                original_amount_inr: e.amount_inr,
                markup_type: 'none',
                markup_value: 0,
                markup_amount: 0,
              }
            })
            await supabase.from('invoice_expense_items').insert(expRows)
          }
        }

        // Recompute totals from the actual rows now on the invoice (correct
        // whether this was a fresh invoice or an existing draft appended to).
        const [{ data: itemRows }, { data: expRowsAll }] = await Promise.all([
          supabase.from('invoice_items').select('total').eq('invoice_id', invId),
          supabase.from('invoice_expense_items').select('amount').eq('invoice_id', invId),
        ])
        const subtotal = (itemRows || []).reduce((s, r) => s + (r.total || 0), 0) + (expRowsAll || []).reduce((s, r) => s + (r.amount || 0), 0)
        const discount = existingDraft?.discount_amount || 0
        const tax = existingDraft?.tax_amount || 0
        const prevBalance = existingDraft?.previous_balance || 0
        const totalAmount = round2(subtotal - discount + tax + prevBalance)
        await supabase.from('invoices').update({ subtotal, total_amount: totalAmount, updated_at: new Date().toISOString() }).eq('id', invId)

        doneCount++
        setBatchDone(doneCount)
      } catch { errorCount++ }
    }

    // Reload invoices
    const { data: newInvoices } = await supabase
      .from('invoices')
      .select('*, client:clients(id,name,code,phone,email,address), items:invoice_items(*, task:tasks(id,title,task_date,status,billing_amount_inr,currency), service:services(id,name)), payments(*)')
      .order('created_at', { ascending: false })

    if (newInvoices) setInvoices(newInvoices.map(inv => ({
      ...inv,
      subtotal: (inv as any).subtotal || ((inv.total_amount || 0) + ((inv as any).discount_amount || 0) - ((inv as any).tax_amount || 0) - ((inv as any).previous_balance || 0)),
      tax_rate: (inv as any).tax_rate ?? 0,
      tax_amount: (inv as any).tax_amount ?? 0,
      discount_amount: (inv as any).discount_amount ?? 0,
      previous_balance: (inv as any).previous_balance ?? 0,
    })))

    setBatchGenerating(false)
    if (errorCount > 0) {
      toastError(`${doneCount} invoices created, ${errorCount} failed`)
    } else {
      success(`${doneCount} invoice${doneCount !== 1 ? 's' : ''} created successfully`)
    }
    // Clear generated groups from list
    await fetchBatchGroups()
  }

  async function loadDiscountAnalytics() {
    if (discAnalyticsLoaded) return
    setDiscAnalyticsLoading(true)
    const { data } = await supabase
      .from('discount_logs')
      .select('*, invoice:invoices(invoice_number, total_amount, status, currency), client:clients(id, name, code, default_currency)')
      .order('created_at', { ascending: false })
    setDiscAnalytics(data || [])
    setDiscAnalyticsLoading(false)
    setDiscAnalyticsLoaded(true)
  }

  async function loadJobLosses(force = false) {
    if (jobLossesLoaded && !force) return
    setJobLossesLoading(true)

    // Step 1: fetch cancelled tasks — simple join only (no triple-nested alias)
    const { data: tasks, error: tErr } = await supabase
      .from('tasks')
      .select('id, title, task_date, billing_amount_inr, currency, cancelled_by, cancellation_notes, honor_contributions, loss_amount, completion_pct, client:clients(id, name), service:services!service_id(name)')
      .eq('status', 'cancelled')
      .order('task_date', { ascending: false })
    if (tErr) console.error('loadJobLosses tasks error:', tErr)

    // Filter in JS — avoids any issues with .gt() on nullable decimal column
    const lostTasks = (tasks || []).filter((t: any) => (t.loss_amount || 0) > 0)

    if (lostTasks.length > 0) {
      // Step 2: fetch contribution_scores for these tasks separately
      const taskIds = lostTasks.map((t: any) => t.id)
      const { data: contribs, error: cErr } = await supabase
        .from('contribution_scores')
        .select('task_id, earnings_inr, employee:employees(name, cqid)')
        .in('task_id', taskIds)
      if (cErr) console.error('loadJobLosses contributions error:', cErr)

      // Merge contributions into tasks
      const contribMap: Record<string, any[]> = {}
      ;(contribs || []).forEach((c: any) => {
        if (!contribMap[c.task_id]) contribMap[c.task_id] = []
        contribMap[c.task_id].push(c)
      })
      const merged = lostTasks.map((t: any) => ({ ...t, contributions: contribMap[t.id] || [] }))
      setJobLosses(merged)
    } else {
      setJobLosses([])
    }

    setJobLossesLoading(false)
    setJobLossesLoaded(true)
  }

  async function loadAdvancePayments() {
    if (advanceLoaded) return
    setAdvanceLoading(true)
    const { data } = await supabase
      .from('payments')
      .select('*, invoice:invoices(invoice_number, client_id, total_amount, client:clients(id, name))')
      .ilike('notes', '%ADVANCE PAYMENT%')
      .order('payment_date', { ascending: false })
    setAdvancePayments(data || [])
    setAdvanceLoading(false)
    setAdvanceLoaded(true)
  }

  async function loadExpenseReport() {
    if (expenseReportLoaded) return
    setExpenseReportLoading(true)
    const { data } = await supabase
      .from('invoice_expense_items')
      .select('*, invoice:invoices(invoice_number, status, currency, client:clients(id, name))')
      .order('created_at', { ascending: false })
    setExpenseReport(data || [])
    setExpenseReportLoading(false)
    setExpenseReportLoaded(true)
  }

  /**
   * Pull `items` + `cashbook_invoice_allocations` for invoices that don't have
   * them yet, and merge into state.
   *
   * The list query ships neither (they were 80% of its payload), so EVERY read
   * of `inv.items` must await this first — otherwise the caller sees an empty
   * array and silently does nothing, which on this screen means an invoice
   * deleted without reverting its tasks, or a statement printed with no lines.
   *
   * Returns the up-to-date rows so callers use the result rather than the
   * `invoices` state they closed over, which React has not updated yet.
   */
  async function ensureDetails(ids: string[]): Promise<Invoice[]> {
    const wanted = [...new Set(ids.filter(Boolean))]
    const missing = wanted.filter(id => !detailLoaded.has(id))

    let merged = invoices
    if (missing.length) {
      const res = await getInvoiceDetails(missing)
      if (!res.ok) {
        toastError(res.error || 'Could not load invoice line items')
        // Record the failure so the panel can offer a retry instead of
        // spinning, and so Preview/Print/Download can refuse to render a
        // document they know is incomplete.
        setDetailFailed(prev => { const n = new Set(prev); missing.forEach(id => n.add(id)); return n })
        return invoices.filter(i => wanted.includes(i.id))
      }
      setDetailFailed(prev => {
        if (!missing.some(id => prev.has(id))) return prev
        const n = new Set(prev); missing.forEach(id => n.delete(id)); return n
      })
      const byId = new Map((res.data || []).map((d: any) => [d.id, d]))
      const applyTo = (list: Invoice[]) => list.map(i => {
        const d = byId.get(i.id)
        return d ? { ...i, items: d.items || [], cashbook_invoice_allocations: d.cashbook_invoice_allocations || [] } : i
      })

      // FUNCTIONAL updater, not setInvoices(<snapshot>.map(...)).
      //
      // `invoices` here is the snapshot from the render that started this call.
      // Clicking through invoices fires overlapping ensureDetails calls, and a
      // slower one finishing second used to write ITS stale snapshot over the
      // faster one's result — silently dropping line items that had already
      // loaded, on an invoice that detailLoaded still counted as loaded. The
      // detail panel then showed "0 items" for an invoice that has items, with
      // no way to recover short of a reload. Merging onto `prev` composes
      // instead of clobbering, so completion order stops mattering.
      setInvoices(prev => applyTo(prev))

      // Only ids the server actually returned. Marking an id loaded when it
      // came back empty is what made that bad state permanent: the guard above
      // then skipped every retry.
      setDetailLoaded(prev => {
        const next = new Set(prev)
        missing.filter(id => byId.has(id)).forEach(id => next.add(id))
        return next
      })

      merged = applyTo(invoices)
    }
    return merged.filter(i => wanted.includes(i.id))
  }

  async function refreshInvoice(invoiceId: string) {
    const { data } = await supabase.from('invoices')
      .select('*, client:clients(id,name,code,phone,email), items:invoice_items(*, task:tasks(id,title,task_date,status,billing_amount_inr,currency), service:services(id,name)), payments(*), cashbook_invoice_allocations(id, deleted_at, allocated_amount, cashbook_entry:cashbook_entries(id, reference, entry_date, description, receipt_number, bank_account:bank_accounts(name)))')
      .eq('id', invoiceId).single()
    if (data) {
      setInvoices(prev => prev.map(i => i.id === invoiceId ? data as any : i))
      setDetailLoaded(prev => new Set(prev).add(invoiceId))
    }
  }

  // ── Invoice print-design helpers ──────────────────────────────────────────
  function buildInvoiceHtml(inv: Invoice, opts?: { autoprint?: boolean; forRaster?: boolean }): string {
    const otherOutstanding = includeOutstanding.has(inv.id) ? (otherOutstandingByInvoice[inv.id] || 0) : undefined
    const agreements = agreementBreakdowns?.[inv.id]
    return renderInvoiceHtml(inv as any, companySettings, { ...opts, otherOutstanding, agreements })
  }

  // "Include other outstanding invoices" toggle — computes the client's live
  // outstanding balance from their OTHER sent/partial/overdue invoices (same
  // query as the existing Prev. Balance auto-fill) and shows it as an extra
  // line on the Preview/PDF only. Never written to the database — toggling
  // off (or closing the modal) discards it.
  async function toggleIncludeOutstanding(inv: Invoice) {
    if (includeOutstanding.has(inv.id)) {
      setIncludeOutstanding(prev => { const n = new Set(prev); n.delete(inv.id); return n })
      return
    }
    setLoadingOutstandingId(inv.id)
    try {
      const { data } = await supabase.from('invoices')
        .select('total_amount,paid_amount,status')
        .eq('client_id', inv.client_id)
        .in('status', ['sent', 'partial', 'overdue'])
        .neq('id', inv.id)
      const pending = (data || []).reduce((s, i) => s + Math.max(0, (i.total_amount || 0) - (i.paid_amount || 0)), 0)
      setOtherOutstandingByInvoice(prev => ({ ...prev, [inv.id]: pending }))
      setIncludeOutstanding(prev => new Set(prev).add(inv.id))
      if (pending <= 0) toastError('No other outstanding balance found for this client')
    } finally {
      setLoadingOutstandingId(null)
    }
  }

  function printInvoice(inv: Invoice) {
    const html = buildInvoiceHtml(inv, { autoprint: true })
    const w = window.open('', '_blank', 'width=800,height=900')
    if (w) { w.document.write(html); w.document.close() }
  }

  // Genuine file download (distinct from Print, which only offers the OS print
  // dialog's "Save as PDF" — not a real download event). Delegates to the
  // row-aware pagination pipeline in lib/invoices/download-pdf.ts: measures the
  // real row heights, packs whole rows onto A4 pages (never splitting one
  // across a page break), and rasterizes each page separately. jsPDF's .save()
  // triggers a real browser download, so on Cirqle Desktop it lands in the
  // common Downloads shelf like any other file.
  async function downloadInvoicePdf(inv: Invoice) {
    setDownloadingInvId(inv.id)
    try {
      const { downloadInvoicePdf: download } = await import('@/lib/invoices/download-pdf')
      await download(inv as any, companySettings, {
        otherOutstanding: includeOutstanding.has(inv.id) ? (otherOutstandingByInvoice[inv.id] || 0) : undefined,
      })
    } catch (e) {
      console.error('Invoice PDF download failed', e)
      toastError('Could not generate the PDF. Try Print instead.')
    } finally {
      setDownloadingInvId(null)
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  function StatusBadge({ status, className }: { status: string; className?: string }) {
    return (
      <span className={cn(`text-[10px] font-semibold px-2 py-0.5 rounded-full ${getStatusColor(status)}`, className)}>
        {getStatusLabel(status)}
      </span>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEFT PANEL — Invoice List
  // ─────────────────────────────────────────────────────────────────────────
  function renderList() {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-background">
        {/* Search + filter bar */}
        <div className="px-4 py-3 border-b border-border/40 space-y-3 bg-secondary/20">
          <TokenizedSearch
            facets={searchFacets}
            onFacetsChange={setSearchFacets}
            draft={searchDraft}
            onDraftChange={setSearchDraft}
            placeholder="Search invoice or client…"
            resultCount={filtered.length}
            resultNoun="invoice"
            fields={[
              { key: 'number', label: 'Invoice #', type: 'text' },
              { key: 'client', label: 'Client', type: 'text' },
              { key: 'amount', label: 'Amount ₹', type: 'number' },
            ]}
          />
          <div className="flex flex-col lg:flex-row gap-2 items-start lg:items-center justify-between w-full">
            <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar w-full lg:w-auto shrink-0 pb-1 lg:pb-0 [&>*]:shrink-0">
              {['', 'draft', 'reviewed', 'sent', 'partial', 'overdue'].map(s => (
                <button key={s}
                  onClick={() => setFilterStatus(s)}
                  className={cn(
                    "text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors border",
                    filterStatus === s
                      ? "bg-foreground text-background border-foreground shadow-sm"
                      : "bg-background text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground"
                  )}
                >{s ? getStatusLabel(s) : 'All'}</button>
              ))}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={() => setGroupByClient(g => !g)}
                title="Group the list by client"
                className={cn(
                  "flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors border",
                  groupByClient
                    ? "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30"
                    : "bg-background text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground"
                )}
              >
                <Layers className="w-3 h-3" /> Group
              </button>
              {filtered.length > 0 && (
                <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                  <input
                    type="checkbox"
                    className="rounded border-border/50 bg-background text-violet-500 focus:ring-0 cursor-pointer h-3.5 w-3.5"
                    checked={filtered.length > 0 && filtered.every(i => selectedForBulk.has(i.id))}
                    onChange={toggleSelectAllBulk}
                  />
                  Select All
                </label>
              )}
            </div>
          </div>

          {/* Tokenized active filters */}
          <ActiveFilterChips
            chips={[
              ...(filterStatus ? [{ key: 'status', label: 'Status', value: getStatusLabel(filterStatus), onRemove: () => setFilterStatus('') }] : []),
              ...(filterClient ? [{ key: 'client', label: 'Client', value: invoices.find(i => i.client_id === filterClient)?.client?.name || 'Selected', onRemove: () => setFilterClient('') }] : []),
            ]}
            onClearAll={() => { setFilterStatus(''); setFilterClient('') }}
          />

          <div className="flex justify-between items-center px-1 pt-1 mt-1">
            <span className="text-[11px] font-medium text-muted-foreground">{filtered.length} invoice{filtered.length !== 1 ? 's' : ''}</span>
            {/* Portfolio sum — the book's size, not any one invoice. Gated with
                the other aggregates so a collections role sees the invoices it
                chases without the total they add up to. */}
            {showTotals && (
              <span className="text-xs font-bold text-foreground tracking-tight">Total: {fmt(filtered.reduce((s, i) => s + invTotalInr(i), 0))}</span>
            )}
          </div>
          
          {/* Bulk Action Bar — wraps onto multiple lines: this list panel is a
              narrow (~300px) master-detail column, not a full-width table, so
              a single-row flex layout silently overflows off-screen once more
              than ~4 buttons are present. */}
          {selectedForBulk.size > 0 && (
            <div className="bg-violet-500/10 border border-violet-500/30 rounded-lg px-3 py-2 mt-2 animate-in slide-in-from-top-2">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-medium text-violet-700 dark:text-violet-300">{selectedForBulk.size} selected</span>
                  {/* Summing a hand-picked set is still a portfolio figure — and
                      selecting every row would otherwise rebuild the book total
                      the other gates remove. */}
                  {showTotals && (
                    <span className="text-xs font-bold text-violet-700 dark:text-violet-300 border-l border-violet-500/30 pl-3">
                      Due: {fmt(invoices.filter(i => selectedForBulk.has(i.id)).reduce((s, i) => s + balanceDueInr(i), 0))}
                    </span>
                  )}
                </div>
                <button
                  aria-label="Clear selection"
                  onClick={() => setSelectedForBulk(new Set())}
                  className="p-1 text-muted-foreground hover:text-foreground rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button 
                  onClick={() => handleBulkStatusUpdate('reviewed')}
                  disabled={isUpdatingBulk}
                  className="text-[10px] font-medium bg-background border border-border hover:bg-secondary px-2 py-1 rounded transition-colors disabled:opacity-50"
                >
                  Mark Reviewed
                </button>
                <button
                  onClick={handleBulkLogFollowup}
                  disabled={isUpdatingBulk}
                  className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Log Reminder Sent
                </button>
                <button
                  onClick={() => handleBulkStatusUpdate('sent')}
                  disabled={isUpdatingBulk}
                  className="text-[10px] font-medium bg-violet-500 text-white hover:bg-violet-600 px-2 py-1 rounded transition-colors disabled:opacity-50"
                >
                  Mark Sent
                </button>
                <button
                  onClick={handleBulkCancel}
                  disabled={isUpdatingBulk}
                  className="text-[10px] font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 px-2 py-1 rounded transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleBulkResync}
                  disabled={isUpdatingBulk}
                  title="Rebuild line items from linked tasks for every selected draft invoice"
                  className="text-[10px] font-medium bg-background border border-border hover:bg-secondary px-2 py-1 rounded transition-colors disabled:opacity-50 inline-flex items-center gap-1"
                >
                  <ListRestart className={cn("w-3 h-3", isUpdatingBulk && resyncingId && "animate-spin")} />
                  Resync
                </button>
                <button
                  onClick={exportSelectedCSV}
                  disabled={isUpdatingBulk}
                  title="Export just the selected rows (the page-level Export CSV button exports everything)"
                  className="text-[10px] font-medium bg-background border border-border hover:bg-secondary px-2 py-1 rounded transition-colors disabled:opacity-50"
                >
                  Export Selected
                </button>
                <button
                  onClick={generateStatementsForSelected}
                  disabled={isUpdatingBulk}
                  className="text-[10px] font-medium bg-background border border-border hover:bg-secondary px-2 py-1 rounded transition-colors disabled:opacity-50"
                >
                  Statement
                </button>
              </div>
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto divide-y divide-border/30">
          {filtered.length === 0 && (
            <div className="p-6 text-center text-muted-foreground text-sm">
              {tab === 'active' ? 'No active invoices' : tab === 'closed' ? 'No closed invoices' : 'No invoices'}
            </div>
          )}
          {groupByClient
            ? clientGroups.map(g => (
                <div key={g.clientId}>
                  <div className="sticky top-0 z-[1] px-3 py-1.5 bg-secondary/70 backdrop-blur-sm border-y border-border/30 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-foreground truncate">{g.clientName}</span>
                    <span className="flex items-center gap-2 shrink-0 text-[10px] text-muted-foreground">
                      <span>{g.invoices.length} inv</span>
                      {g.balanceInr > 0 && <span className="text-red-400 font-medium">₹{g.balanceInr.toLocaleString('en-IN')} due</span>}
                    </span>
                  </div>
                  <div className="divide-y divide-border/30">
                    {g.invoices.map(inv => renderInvoiceRow(inv))}
                  </div>
                </div>
              ))
            : filtered.map(inv => renderInvoiceRow(inv))}
        </div>
      </div>
    )

    function renderInvoiceRow(inv: Invoice) {
      const balance = balanceDue(inv)
      const overdue = isOverdue(inv.due_date || '', inv.status, inv.issue_date)
      const isSelected = selectedInv?.id === inv.id

      return (
        <div
          key={inv.id}
          onClick={() => selectInvoice(inv.id)}
          className={cn(
            "group relative flex items-start gap-3 px-4 py-3.5 cursor-pointer transition-all border-l-2",
            isSelected
              ? "bg-violet-500/5 dark:bg-violet-500/10 border-violet-500"
              : "border-transparent hover:bg-secondary/50 dark:hover:bg-white/[0.02]"
          )}
        >
          <div className="pt-0.5 shrink-0" onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              className={cn(
                "rounded border-border/50 bg-background text-violet-500 focus:ring-0 cursor-pointer h-4 w-4 transition-opacity",
                selectedForBulk.has(inv.id) ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              checked={selectedForBulk.has(inv.id)}
              onChange={(e) => toggleBulkSelection(e as unknown as React.MouseEvent, inv.id)}
            />
          </div>
          
          <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); copyInvNum(inv.invoice_number) }}
                  title="Copy invoice number"
                  className="flex items-center gap-1 text-[11px] font-mono font-medium text-muted-foreground hover:text-foreground transition-colors group/copy"
                >
                  {inv.invoice_number}
                  <Copy className="w-2.5 h-2.5 opacity-0 group-hover/copy:opacity-100 transition-opacity" />
                </button>
                <StatusBadge status={overdue && inv.status !== 'paid' ? 'overdue' : inv.status} className="h-5 px-1.5 text-[10px]" />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className={cn(
                  "text-sm font-semibold tabular-nums",
                  balance > 0 && overdue ? "text-red-600 dark:text-red-400" : balance > 0 ? "text-foreground" : "text-emerald-600 dark:text-emerald-400"
                )}>
                  {fmt(balance > 0 ? balance : inv.total_amount, inv.currency)}
                </div>
              </div>
            </div>

            {!groupByClient && (
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-foreground truncate">
                  {inv.client?.name || '—'}
                </div>
                {role === 'super_admin' && (
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setEditClientId(inv.client_id) }}
                    title={`Edit ${inv.client?.name}`}
                    className="text-muted-foreground/30 hover:text-violet-500 transition-colors shrink-0"
                  >
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground mt-0.5">
              <div className="truncate flex items-center gap-1.5">
                {inv.billing_period_start ? formatBillingPeriod(inv.billing_period_start) : `Issued ${fmtDate(inv.issue_date)}`}
                {taskCountOf(inv) > 0 && (
                  <>
                    <span className="opacity-30">·</span>
                    <span>{taskCountOf(inv)} task{taskCountOf(inv) !== 1 ? 's' : ''}</span>
                  </>
                )}
              </div>
              <div className={cn("shrink-0", overdue && inv.status !== 'paid' && "text-red-600 dark:text-red-400 font-medium")}>
                {inv.status === 'paid' ? 'Paid' : `Due ${fmtDate(inv.due_date)}`}
              </div>
            </div>
          </div>
        </div>
      )
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Invoice Detail
  // ─────────────────────────────────────────────────────────────────────────
  function renderDetail(inv: Invoice) {
    // Line items arrive AFTER first paint now (ensureDetails), so an invoice
    // whose detail hasn't landed yet has `items === undefined` — which is NOT
    // the same as an invoice with zero items. Telling them apart matters on a
    // billing screen: rendering the empty state during the ~1.5s fetch read as
    // "auto-collection produced nothing", inviting someone to re-add lines
    // that already existed.
    const detailFailedHere = detailFailed.has(inv.id)
    const detailPending = !detailLoaded.has(inv.id) && !detailFailedHere
    const knownItemCount = detailPending ? taskCountOf(inv) : (inv.items?.length || 0)
    const forceEdit = forceEditId === inv.id
    const editable = isEditable(inv.status) || forceEdit
    const balance = balanceDue(inv)
    const overdue = isOverdue(inv.due_date || '', inv.status, inv.issue_date)
    const nextAct = getNextAction(inv.status)
    const periodLabel = inv.billing_period_start ? formatBillingPeriod(inv.billing_period_start) : null

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header.
            flex-wrap + min-w-[160px] on the info block: same fix as the
            shared <Header> component — a shrink-0 icon cluster (6 buttons)
            claiming more width than was left made the invoice-number/badge
            row's min-w-0 squeeze to a literal 0px box (number invisible)
            instead of just truncating. The floor stops the squeeze; wrap
            drops the icon cluster to its own row on phones once the info
            block has claimed a sane minimum. */}
        <div className="px-5 py-5 border-b border-border/40 bg-card flex flex-wrap items-start justify-between gap-x-4 gap-y-2 shrink-0">
          <div className="min-w-[160px] flex-1">
            <div className="flex items-center gap-3 mb-1.5">
              <button
                type="button"
                onClick={() => copyInvNum(inv.invoice_number)}
                title="Copy invoice number"
                className="flex items-center gap-1.5 font-mono text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group min-w-0"
              >
                {/* truncate (not implicit wrap): the icon cluster on the right
                    (shrink-0) can leave this row very little space on phones —
                    without truncate the number's hyphens gave the browser line-
                    break points and it wrapped "INV-2607-053-2" across 3 lines. */}
                <span className="truncate">{inv.invoice_number}</span>
                <Copy className={`w-3.5 h-3.5 shrink-0 transition-colors ${copiedInvNum ? 'text-green-500' : 'opacity-0 group-hover:opacity-60'}`} />
              </button>
              <StatusBadge status={overdue && inv.status !== 'paid' ? 'overdue' : inv.status} className="h-6 px-2.5 text-[11px]" />
              {editable && (
                <span className="text-[10px] uppercase tracking-wider font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-md">Editable</span>
              )}
            </div>
            <h3 className="text-xl font-bold text-foreground mb-2 truncate">{inv.client?.name}</h3>
            <div className="flex items-center gap-4 text-xs text-muted-foreground font-medium">
              {periodLabel && <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" />{periodLabel}</span>}
              <span className="flex items-center gap-1.5"><span className="opacity-50">Issued</span> {fmtDate(inv.issue_date)}</span>
              {editable ? (
                <span className="flex items-center gap-1.5">
                  <span className="opacity-50">Due</span>
                  <input
                    type="date"
                    value={inv.due_date || ''}
                    onChange={async e => {
                      const val = e.target.value
                      await supabase.from('invoices').update({ due_date: val || null }).eq('id', inv.id)
                      setInvoices(prev => prev.map(i => i.id === inv.id ? { ...i, due_date: val } : i))
                    }}
                    className="bg-transparent border-b border-dashed border-border hover:border-violet-500/60 focus:border-violet-500 focus:outline-none text-xs cursor-pointer text-foreground"
                  />
                </span>
              ) : inv.due_date ? (
                <span className={cn("flex items-center gap-1.5", overdue && inv.status !== 'paid' && 'text-red-600 dark:text-red-400 font-semibold')}>
                  <span className="opacity-50">Due</span> {fmtDate(inv.due_date)}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 items-start justify-end shrink-0">
            <button onClick={() => refreshInvoice(inv.id)} title="Reload this invoice (re-fetch latest data)"
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors border border-transparent hover:border-border/50">
              <RotateCw className="w-4 h-4" />
            </button>
            <button onClick={() => setPreviewInv(inv)} title="Preview invoice"
              className="p-2 text-muted-foreground hover:text-violet-500 hover:bg-violet-500/10 rounded-lg transition-colors border border-transparent hover:border-violet-500/20">
              <Eye className="w-4 h-4" />
            </button>
            <button onClick={() => printInvoice(inv)} disabled={!canSharePdf}
              title={canSharePdf ? 'Print' : noShareReason}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors border border-transparent hover:border-border/50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground">
              <Printer className="w-4 h-4" />
            </button>
            <button onClick={() => downloadInvoicePdf(inv)} disabled={!canSharePdf || downloadingInvId === inv.id}
              title={canSharePdf ? 'Download PDF' : noShareReason}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg transition-colors border border-transparent hover:border-border/50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground">
              {downloadingInvId === inv.id
                ? <RefreshCw className="w-4 h-4 animate-spin" />
                : <Download className="w-4 h-4" />}
            </button>
            <button
              onClick={() => {
                const text = buildInvoiceShareText({
                  invoiceNumber: inv.invoice_number,
                  clientName:    inv.client?.name ?? null,
                  companyName:   companySettings.company_name || 'Cirqle Works',
                  amount:        inv.total_amount,
                  dueDate:       inv.due_date,
                  showAmounts,
                  link:          publicInvoiceUrl((inv as any).public_token),
                  template:      companySettings[TEMPLATE_KEYS.invoiceShare],
                })
                window.open(whatsappShareUrl(text, inv.client?.phone ?? null), '_blank', 'noopener,noreferrer')
              }}
              title="Share via WhatsApp"
              className="p-2 text-muted-foreground hover:text-green-500 hover:bg-green-500/10 rounded-lg transition-colors border border-transparent hover:border-green-500/20">
              <Share2 className="w-4 h-4" />
            </button>
            {!isEditable(inv.status) && (
              <button
                onClick={() => forceEdit ? lockEdit() : requestEditUnlock(inv.id)}
                title={forceEdit ? 'Lock editing' : 'Force edit (requires reason)'}
                className={cn(
                  "p-2 rounded-lg transition-colors border",
                  forceEdit 
                    ? "text-amber-500 bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/20" 
                    : "text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 border-transparent hover:border-amber-500/20"
                )}>
                {forceEdit ? <Lock className="w-4 h-4" /> : <Edit2 className="w-4 h-4" />}
              </button>
            )}
            
            {inv.status === 'draft' && (
              <button onClick={() => handleResync(inv.id)} disabled={saving}
                title="Re-sync line items from this month's completed tasks"
                className="p-2 text-muted-foreground hover:text-blue-500 hover:bg-blue-500/10 rounded-lg transition-colors border border-transparent hover:border-blue-500/20 disabled:opacity-50">
                <ListRestart className={cn("w-4 h-4", resyncingId === inv.id && "animate-spin")} />
              </button>
            )}
            <button onClick={() => confirmDelete(inv.id)} title="Delete"
              className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors border border-transparent hover:border-red-500/20">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

          {/* Action bar — one slim row: progress on the left, the one or two
              actions that matter now on the right. Everything else lives under
              "More actions" so the panel opens straight onto the line items. */}
          <div className="bg-foreground/[0.03] rounded-xl border border-border/40 px-3 py-2">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1 min-w-0" title={`Stage: ${getStatusLabel(inv.status)}`}>
                {STATUS_PIPELINE.map((s, idx) => {
                  const pos = STATUS_PIPELINE.indexOf(inv.status)
                  const isPast = idx < pos
                  const isCurrent = s === inv.status
                  return (
                    <div key={s} className="flex items-center">
                      <span className={cn('w-2 h-2 rounded-full shrink-0',
                        isCurrent ? 'bg-violet-500 ring-2 ring-violet-500/30' : isPast ? 'bg-green-500' : 'bg-border')} />
                      {isCurrent && (
                        <span className="ml-1.5 text-[11px] font-semibold text-violet-500 whitespace-nowrap">{getStatusLabel(s)}</span>
                      )}
                      {idx < STATUS_PIPELINE.length - 1 && <span className={cn('w-3 h-px mx-1', isPast ? 'bg-green-500/40' : 'bg-border/60')} />}
                    </div>
                  )
                })}
              </div>
              <div className="flex-1" />
              {nextAct && (
                <button
                  onClick={() => updateStatus(inv.id, nextAct.next)}
                  disabled={saving}
                  className="py-1.5 px-3.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50">
                  {nextAct.next === 'reviewed' && <Eye className="w-3.5 h-3.5" />}
                  {nextAct.next === 'sent' && <Send className="w-3.5 h-3.5" />}
                  {nextAct.next === 'partial' && <CreditCard className="w-3.5 h-3.5" />}
                  {nextAct.next === 'paid' && <CheckCircle className="w-3.5 h-3.5" />}
                  {nextAct.label}
                </button>
              )}
              {['sent', 'partial', 'overdue'].includes(inv.status) && (
                <button
                  onClick={() => openPayPanel(inv)}
                  className="py-1.5 px-3.5 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg flex items-center gap-1.5 transition-colors">
                  <CreditCard className="w-3.5 h-3.5" />Record Payment
                </button>
              )}
            </div>

            {/* Everything secondary, one click away */}
            <details className="mt-1.5">
              <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground list-none flex items-center gap-1 w-fit">
                <MoreHorizontal className="w-3 h-3" /> More actions
              </summary>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {inv.status === 'draft' && (
                  <button onClick={() => openPayPanel(inv)}
                    className="py-1 px-2.5 bg-foreground/[0.05] hover:bg-foreground/[0.1] text-foreground text-[11px] font-medium rounded-lg flex items-center gap-1.5 border border-border/40 transition-colors">
                    <CreditCard className="w-3 h-3" />Quick Pay
                  </button>
                )}
                <button
                  onClick={() => setApprovalInvoice({ id: inv.id, invoice_number: inv.invoice_number, client_id: inv.client_id ?? null })}
                  className="py-1 px-2.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 text-[11px] font-medium rounded-lg flex items-center gap-1.5 transition-colors">
                  <CheckCircle className="w-3 h-3" />Request Approval
                </button>
                {/* Allocate From Cash Book — alternate entry point into the same
                    allocation engine; multiple allocations per invoice allowed. */}
                {showAmounts
                  && !STATUS_GROUPS.closed.includes(inv.status)
                  && balanceDueInr(inv) > 0.01 && (
                  <button
                    onClick={() => setAllocatingInvoice(inv)}
                    className="py-1 px-2.5 bg-violet-600/10 hover:bg-violet-600/20 text-violet-700 dark:text-violet-300 border border-violet-500/30 text-[11px] font-medium rounded-lg flex items-center gap-1.5 transition-colors">
                    <Wallet className="w-3 h-3" />Allocate From Cash Book
                  </button>
                )}
                {!STATUS_GROUPS.closed.includes(inv.status) && (
                  <button
                    onClick={() => setAddExpenseInvoice(inv)}
                    className="py-1 px-2.5 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 text-[11px] font-medium rounded-lg flex items-center gap-1.5 transition-colors">
                    <ShoppingBag className="w-3 h-3" />Add Expenses
                  </button>
                )}
                <span className="w-px self-stretch bg-border/50 mx-0.5" />
                {['draft', 'reviewed', 'sent', 'partial', 'paid', 'overdue', 'cancelled', 'bad_debt'].map(s => (
                  <button key={s} onClick={() => requestStatusChange(inv, s)}
                    disabled={saving || inv.status === s}
                    title={`Set status to ${getStatusLabel(s)}`}
                    className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors disabled:opacity-30 self-center
                      ${inv.status === s ? getStatusColor(s) : 'border-border/40 text-muted-foreground hover:border-violet-500/50 hover:text-violet-400'}`}>
                    {getStatusLabel(s)}
                  </button>
                ))}
              </div>
            </details>
          </div>

          {/* Client Expenses section — hidden here, expenses now shown inline in LINE ITEMS above */}
          {false && (inv.expense_items || []).length > 0 && (() => {
            const expMode = inv.expenses_mode || companySettings.expense_display_mode || 'mode_a'
            const expTotal = (inv.expense_items || []).reduce((s, e) => s + (e.amount || 0), 0)
            const origTotal = (inv.expense_items || []).reduce((s, e) => s + (e.original_amount || e.amount || 0), 0)
            const markupTotal = (inv.expense_items || []).reduce((s, e) => s + (e.markup_amount || 0), 0)
            return (
              <div className="bg-amber-500/[0.04] rounded-xl border border-amber-500/20 p-3 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-1">
                  <h4 className="text-[11px] font-semibold text-amber-700 dark:text-amber-300/90 uppercase tracking-wider flex items-center gap-1.5">
                    <ShoppingBag className="w-3 h-3" />Client Expenses ({(inv.expense_items || []).length})
                  </h4>
                  {/* PDF display mode toggle A/B/C */}
                  {showAmounts && (
                    <div className="flex items-center gap-1 text-[10px]">
                      {[
                        { id: 'mode_a', label: 'A · Clean' },
                        { id: 'mode_b', label: 'B · Breakdown' },
                        { id: 'mode_c', label: 'C · Reimbursable' },
                      ].map(m => (
                        <button key={m.id} onClick={() => updateExpensesMode(inv.id, m.id)}
                          className={`px-2 py-0.5 rounded-full border transition-colors ${expMode === m.id
                            ? 'bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300'
                            : 'border-border/30 text-muted-foreground hover:border-border/60'}`}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {(inv.expense_items || []).map(exp => {
                  const hasMarkup = exp.markup_type !== 'none' && (exp.markup_amount || 0) > 0
                  return (
                    <div key={exp.id} className="text-xs">
                      <div className="flex items-start gap-2">
                        <span className="text-foreground/80 truncate flex-1">{exp.description}</span>
                        {showAmounts && (
                          <span className="font-mono text-amber-700 dark:text-amber-300/90 shrink-0 font-semibold">
                            {fmt(exp.amount, exp.currency as Currency)}
                          </span>
                        )}
                      </div>
                      {hasMarkup && showAmounts && (
                        <div className="text-[10px] text-muted-foreground ml-0 mt-0.5">
                          Cost {fmt(exp.original_amount || 0, exp.currency as Currency)} ·
                          Markup {exp.markup_type === 'percentage'
                            ? `${exp.markup_value}%`
                            : fmt(exp.markup_amount || 0, exp.currency as Currency)} = {fmt(exp.amount, exp.currency as Currency)}
                        </div>
                      )}
                      {exp.notes && <div className="text-[10px] text-muted-foreground/60 italic mt-0.5">{exp.notes}</div>}
                    </div>
                  )
                })}
                {showAmounts && (
                  <div className="pt-1.5 border-t border-amber-500/20 space-y-0.5">
                    {markupTotal > 0 && (
                      <>
                        <div className="flex justify-between text-[10px] text-muted-foreground">
                          <span>Cost basis</span>
                          <span className="font-mono">{fmt(origTotal, inv.currency)}</span>
                        </div>
                        <div className="flex justify-between text-[10px] text-amber-700 dark:text-amber-300/70">
                          <span>Markup earned</span>
                          <span className="font-mono">+{fmt(markupTotal, inv.currency)}</span>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between text-[11px] text-amber-700 dark:text-amber-300/90 font-semibold">
                      <span>Billed to client</span>
                      <span className="font-mono">{fmt(expTotal, inv.currency)}</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Line items — document-style ledger card: framed header band,
              a column rule, numbered ruled rows and an in-card subtotal, so
              the section reads like the actual invoice the client receives. */}
          <div className="mb-6 rounded-2xl border border-border/60 bg-card overflow-hidden shadow-sm">
            <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-500/[0.08] via-violet-500/[0.02] to-transparent border-b border-border/50">
              <h4 className="text-sm font-semibold text-foreground tracking-tight flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-violet-500/15 flex items-center justify-center shrink-0">
                  <ListTree className="w-3.5 h-3.5 text-violet-500" />
                </span>
                Line Items
                <span className="text-[10px] font-semibold text-violet-600 dark:text-violet-300 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full tabular-nums">
                  {knownItemCount + (inv.expense_items?.length || 0)}
                </span>
              </h4>
              <div className="flex items-center gap-2">
                {forceEdit && (
                  <span className="text-[10px] text-amber-500 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <Lock className="w-3 h-3" /> Force edit on
                  </span>
                )}
                {!forceEdit && isEditable(inv.status) && (
                  <span className="text-[10px] text-amber-500 flex items-center gap-1 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                    <Zap className="w-3 h-3" />Auto-collecting
                  </span>
                )}
              </div>
            </div>
            {/* Column rule — mirrors a printed invoice's table header */}
            <div className="hidden sm:flex items-center gap-3 px-4 py-1.5 text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50 bg-secondary/30 border-b border-border/40">
              <span className="w-5 text-right shrink-0">#</span>
              <span className="flex-1">Description</span>
              <span className="text-right">Amount</span>
            </div>
            <div className="divide-y divide-border/40">
              {detailPending && (
                <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-8">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  Loading line items…
                </div>
              )}
              {detailFailedHere && (
                <div className="flex flex-col items-center justify-center gap-2 text-xs py-8 px-4 text-center">
                  <span className="text-muted-foreground">
                    Couldn&apos;t load this invoice&apos;s line items, so they aren&apos;t shown here
                    and the PDF would be incomplete.
                  </span>
                  <button
                    onClick={() => {
                      setDetailFailed(prev => { const n = new Set(prev); n.delete(inv.id); return n })
                      void ensureDetails([inv.id])
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 border border-foreground/15 font-medium transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />Try again
                  </button>
                </div>
              )}
              {!detailPending && !detailFailedHere && (inv.items || []).length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-8">
                  No items yet — tasks marked &quot;done&quot; auto-appear here
                </div>
              )}
              {/* Copy before sorting — Array#sort mutates, and `inv.items` is React state. */}
              {[...(inv.items || [])].sort(compareInvoiceItems).map((item, idx) => (
                <div key={item.id} className="relative flex items-start gap-3 px-4 py-3 hover:bg-violet-500/[0.04] transition-colors group">
                  <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-violet-500/0 group-hover:bg-violet-500/60 transition-colors" />
                  <span className="w-5 text-right shrink-0 pt-0.5 text-[10px] font-mono text-muted-foreground/50 tabular-nums select-none">
                    {String(idx + 1).padStart(2, '0')}
                  </span>
                  <div className="flex-1 min-w-0">
                    {editable ? (
                      <input
                        defaultValue={item.description}
                        onBlur={e => { if (e.target.value !== item.description) updateItemDescription(item.id, inv.id, e.target.value) }}
                        className="w-full bg-transparent text-sm font-medium border-b border-transparent hover:border-border/50 focus:border-violet-500/50 focus:outline-none pb-0.5"
                        placeholder="Description…"
                      />
                    ) : (
                      <div className="text-sm font-medium text-foreground truncate">{item.description}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
                      {item.task?.task_date && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{fmtDate(item.task.task_date)}</span>}
                      {item.service?.name && <span className="px-1.5 py-0.5 rounded-md bg-secondary text-secondary-foreground">{item.service.name}</span>}
                      {item.task && (
                        <span className={cn("px-1.5 py-0.5 rounded-md", getStatusColor(item.task.status))}>
                          {getStatusLabel(item.task.status)}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* The editable field is the RATE, the read-only figure is the
                      LINE TOTAL. They differ whenever quantity > 1, so the total
                      is always spelled out rather than left to be inferred. */}
                  <div className="text-right shrink-0">
                    {editable ? (
                      <input
                        type="number" min="0" step="0.01"
                        title="Rate per unit"
                        defaultValue={item.unit_price}
                        onBlur={e => {
                          const v = parseFloat(e.target.value)
                          // Blank/garbage would otherwise write NaN to unit_price AND total.
                          if (!Number.isFinite(v) || v < 0) { e.target.value = String(item.unit_price); return }
                          if (v !== item.unit_price) updateItemPrice(item.id, inv.id, v)
                        }}
                        className="w-24 bg-background border border-border/50 rounded-lg px-2 py-1 text-sm text-right focus:outline-none focus:border-violet-500/50 transition-colors"
                      />
                    ) : (
                      <div className="text-sm font-semibold text-foreground">{fmt(item.total, inv.currency)}</div>
                    )}
                    {item.quantity !== 1 && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {item.quantity} × {fmt(item.unit_price, inv.currency)}
                        {editable && <> = <span className="font-semibold text-foreground">{fmt(item.total, inv.currency)}</span></>}
                      </div>
                    )}
                  </div>
                  {editable && (
                    <button
                      aria-label="Remove item"
                      onClick={e => { e.stopPropagation(); removeItem(inv.id, item.id) }}
                      disabled={removingItemId === item.id}
                      className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all shrink-0 mt-0.5">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              
              {/* Agreement breakdown — what each package fee actually covered.
                  These tasks have NO invoice line of their own (the fee replaced
                  them), so without this the reader cannot tell what the
                  agreement bought. Shown unpriced, matching the PDF. */}
              {(agreementBreakdowns?.[inv.id] || []).map(ag => {
                const key = `${inv.id}:${ag.packageId}`
                const open = expandedAgreements.has(key)
                return (
                  <div key={`ag-${ag.packageId}`} className="relative bg-emerald-500/[0.04]">
                    <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-emerald-400/70" />
                    <button
                      onClick={() => setExpandedAgreements(prev => {
                        const next = new Set(prev)
                        if (next.has(key)) next.delete(key); else next.add(key)
                        return next
                      })}
                      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-emerald-500/[0.08] transition-colors text-left"
                    >
                      <Gift className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground truncate">{ag.packageName}</span>
                          <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded-full shrink-0">
                            {ag.covered.length} included
                          </span>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {ag.allowance.map(a => (
                            `${a.serviceName}: ${a.delivered}/${a.included}${a.extra > 0 ? ` (+${a.extra} extra)` : ''}`
                          )).join(' · ')}
                          {!ag.feeOnThisInvoice && ' · fee charged earlier'}
                        </div>
                      </div>
                      {open
                        ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                        : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />}
                    </button>
                    {open && (
                      <div className="pb-2">
                        {ag.covered.length === 0 && (
                          <div className="px-4 pb-2 pl-11 text-[11px] text-muted-foreground italic">
                            No delivered work covered this period.
                          </div>
                        )}
                        {ag.covered.map((t, i) => (
                          <div key={t.id} className="flex items-center gap-2 px-4 py-1.5 pl-11 text-xs hover:bg-emerald-500/[0.06]">
                            <span className="text-muted-foreground/60 tabular-nums w-5 shrink-0">{i + 1}</span>
                            <span className="text-muted-foreground tabular-nums w-20 shrink-0">
                              {t.taskDate ? fmtDate(t.taskDate) : '—'}
                            </span>
                            <span className="text-foreground truncate flex-1">{t.title}</span>
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium shrink-0 flex items-center gap-1">
                              <Check className="w-3 h-3" /> Included
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Expense items inline in line items */}
              {(inv.expense_items || []).map(exp => (
                <div key={`exp-${exp.id}`} className="relative flex items-start gap-3 px-4 py-3 bg-amber-500/[0.04] hover:bg-amber-500/[0.08] transition-colors group">
                  <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-amber-400/70" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <ShoppingBag className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <div className="text-sm font-medium text-foreground truncate">{exp.description}</div>
                    </div>
                    {exp.markup_type !== 'none' && (exp.markup_amount || 0) > 0 && showAmounts && (
                      <div className="text-[11px] text-muted-foreground ml-5 flex items-center gap-1.5">
                        <span className="opacity-70">Cost {fmt(exp.original_amount || 0, exp.currency as Currency)}</span>
                        <span className="w-1 h-1 rounded-full bg-border"></span>
                        <span className="text-amber-600 dark:text-amber-400">Markup {fmt(exp.markup_amount || 0, exp.currency as Currency)}</span>
                      </div>
                    )}
                    {exp.notes && <div className="text-[11px] text-muted-foreground/70 italic mt-1 ml-5 border-l-2 border-border/50 pl-2">{exp.notes}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    {showAmounts && <div className="text-sm font-semibold text-amber-600 dark:text-amber-400">{fmt(exp.amount, inv.currency as Currency)}</div>}
                  </div>
                  {editable && (
                    <button
                      onClick={async () => {
                        const { error } = await supabase.from('invoice_expense_items').delete().eq('id', exp.id)
                        if (!error) {
                          const newExps = (inv.expense_items || []).filter(e => e.id !== exp.id)
                          const newExpTotal = newExps.reduce((s, e) => s + (e.amount || 0), 0)
                          const taskTotal = (inv.items || []).reduce((s, i) => s + (i.total || 0), 0)
                          const newTotal = round2(taskTotal + newExpTotal - (inv.discount_amount || 0) + (inv.tax_amount || 0) + (inv.previous_balance || 0))
                          await supabase.from('invoices').update({ total_amount: newTotal, subtotal: round2(taskTotal + newExpTotal) }).eq('id', inv.id)
                          setInvoices(prev => prev.map(i => i.id === inv.id
                            ? { ...i, expense_items: newExps, total_amount: newTotal, total_amount_inr: round2(newTotal * (i.exchange_rate || 1)), subtotal: round2(taskTotal + newExpTotal) }
                            : i
                          ))
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all shrink-0 mt-0.5"
                      title="Remove expense from invoice"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}

              {/* Add manual item row */}
              {editable && (() => {
                let addDesc = '', addPrice = 0
                return (
                  <div className="flex gap-3 items-center px-4 py-2.5 bg-secondary/10 border-t border-dashed border-border/50 hover:bg-secondary/20 transition-colors focus-within:bg-violet-500/[0.04] group">
                    <input
                      placeholder="Add manual line item…"
                      onChange={e => { addDesc = e.target.value }}
                      className="flex-1 bg-transparent text-sm font-medium focus:outline-none px-1 placeholder:text-muted-foreground/50"
                    />
                    <input
                      type="number" min="0" placeholder={getCurrencySymbol(inv.currency)}
                      onChange={e => { addPrice = parseFloat(e.target.value) || 0 }}
                      className="w-20 bg-background border border-border/50 rounded-lg px-2 py-1 text-sm text-right focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all"
                    />
                    <button
                      onClick={() => addManualItem(inv.id, addDesc, addPrice)}
                      className="p-1.5 text-violet-500 hover:text-violet-600 hover:bg-violet-500/10 rounded-lg transition-colors border border-transparent group-focus-within:border-violet-500/20"
                      title="Add item">
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                )
              })()}
            </div>
            {/* In-card tally — bridges into the Amounts card below */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-secondary/30 border-t border-border/50">
              <span className="text-[11px] text-muted-foreground font-medium">
                {knownItemCount + (inv.expense_items?.length || 0)} item{(knownItemCount + (inv.expense_items?.length || 0)) !== 1 ? 's' : ''}
              </span>
              <span className="text-sm font-bold tabular-nums">{fmt(inv.subtotal || inv.total_amount, inv.currency)}</span>
            </div>
          </div>

          {/* Amounts — deliberately AFTER the line items: review the work first,
              then the money it adds up to. */}
          <div className="bg-secondary/20 rounded-xl border border-border/50 p-4 space-y-3">
            {editable && invPaidInr(inv) === 0 && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground font-medium">Invoice Currency</span>
                <select
                  value={inv.currency}
                  onChange={e => updateInvoiceCurrency(inv.id, e.target.value as Currency)}
                  className="bg-background border border-border/50 rounded-lg px-2.5 py-1 text-xs font-mono font-medium focus:outline-none focus:border-violet-500/50 focus:ring-2 focus:ring-violet-500/20 transition-all">
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground font-medium">Subtotal</span>
              <span className="font-semibold">{fmt(inv.subtotal || inv.total_amount, inv.currency)}</span>
            </div>

            {(companySettings.gst_enabled === 'true' || (inv.tax_rate || 0) > 0) && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground font-medium">GST / Tax</span>
                {editable ? (
                  <div className="flex items-center gap-2">
                    <div className="relative">
                      <input
                        type="number" min="0" max="100" step="0.5"
                        key={`tax-${inv.id}-${inv.tax_rate}`}
                        defaultValue={inv.tax_rate || 0}
                        onBlur={e => updateTaxRate(inv.id, parseFloat(e.target.value) || 0)}
                        className="w-16 bg-background border border-border/50 rounded-md pl-2 pr-4 py-1 text-xs text-right font-medium focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                      />
                      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
                    </div>
                    <span className="text-xs font-semibold w-24 text-right">{fmt(inv.tax_amount || 0, inv.currency)}</span>
                  </div>
                ) : (
                  <span className="font-medium text-muted-foreground">
                    {inv.tax_rate || 0}% = <span className="text-foreground">{fmt(inv.tax_amount || 0, inv.currency)}</span>
                  </span>
                )}
              </div>
            )}

            {(editable || (inv.discount_amount || 0) > 0) && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground font-medium">Discount</span>
                {editable ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-xs font-semibold">−{getCurrencySymbol(inv.currency)}</span>
                    <input
                      type="number" min="0"
                      key={`disc-${inv.id}-${inv.discount_amount}`}
                      defaultValue={inv.discount_amount || 0}
                      onBlur={e => updateDiscount(inv.id, parseFloat(e.target.value) || 0)}
                      className="w-24 bg-background border border-border/50 rounded-md px-2 py-1 text-xs text-right font-medium focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                    />
                  </div>
                ) : (
                  <span className="text-orange-500 dark:text-orange-400 font-semibold">−{fmt(inv.discount_amount || 0, inv.currency)}</span>
                )}
              </div>
            )}

            <div className="flex justify-between items-center text-sm">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground font-medium text-red-500/80 dark:text-red-400/80">Prev. Balance</span>
                {editable && (
                  <button
                    onClick={() => autoLoadPrevBalance(inv.id, inv.client_id)}
                    title="Auto-fill from pending invoices of this client"
                    className="p-1 text-red-500/60 hover:text-red-500 hover:bg-red-500/10 rounded-md transition-colors">
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {editable ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-red-500/70 dark:text-red-400/70 text-xs font-semibold">+{getCurrencySymbol(inv.currency)}</span>
                  <input
                    type="number" min="0"
                    key={`prevbal-${inv.id}-${inv.previous_balance}`}
                    defaultValue={inv.previous_balance || 0}
                    onBlur={e => updatePreviousBalance(inv.id, parseFloat(e.target.value) || 0)}
                    className="w-24 bg-background border border-border/50 rounded-md px-2 py-1 text-xs text-right font-medium focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500 text-red-600 dark:text-red-400"
                  />
                </div>
              ) : (
                <span className={cn("font-semibold", (inv.previous_balance ?? 0) > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
                  {(inv.previous_balance ?? 0) > 0 ? `+${fmt(inv.previous_balance, inv.currency)}` : '—'}
                </span>
              )}
            </div>

            <div className="border-t border-border/50 pt-3 flex justify-between items-center">
              <span className="font-bold text-foreground">Total</span>
              <span className="font-bold text-lg text-foreground tracking-tight">{fmt(inv.total_amount, inv.currency)}</span>
            </div>

            {inv.currency !== 'INR' && showAmounts && (
              <div className="flex justify-between items-center text-sm bg-foreground/[0.02] p-2 -mx-2 rounded-lg mt-2">
                <span className="text-muted-foreground font-medium text-xs">Exchange rate</span>
                {!['paid', 'cancelled', 'bad_debt'].includes(inv.status) && invPaidInr(inv) === 0 ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground text-[11px] font-medium">1 {inv.currency} = ₹</span>
                    <input
                      type="number" min="0" step="0.0001"
                      key={`rate-${inv.id}-${inv.exchange_rate}`}
                      defaultValue={inv.exchange_rate || ''}
                      onBlur={e => { const v = parseFloat(e.target.value); if (v > 0 && v !== inv.exchange_rate) updateExchangeRate(inv.id, v) }}
                      className="w-24 bg-background border border-border/50 rounded-md px-2 py-0.5 text-xs text-right font-mono focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                    />
                    {(rateMap[inv.currency] || 0) > 0 && Math.abs((inv.exchange_rate || 0) - rateMap[inv.currency]) > 0.0001 && (
                      <button
                        onClick={() => updateExchangeRate(inv.id, rateMap[inv.currency])}
                        title={`Reset to Settings rate ₹${rateMap[inv.currency]}`}
                        className="p-1 text-violet-500/70 hover:text-violet-500 hover:bg-violet-500/10 rounded-md transition-colors">
                        <Undo2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="font-mono text-xs font-medium">1 {inv.currency} = ₹{(inv.exchange_rate || 1).toLocaleString('en-IN')}</span>
                )}
              </div>
            )}
            
            {inv.currency !== 'INR' && showAmounts && (
              <div className="flex justify-between text-[11px] text-muted-foreground px-2">
                <span className="font-medium">Value in ₹ (booked)</span>
                <span className="font-mono font-medium">₹{(inv.total_amount_inr ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
            )}

            {(inv.paid_amount ?? 0) > 0 && (
              <div className="pt-2 space-y-1">
                <div className="flex justify-between text-sm text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-md font-medium">
                  <span>Paid</span>
                  <span>{fmt(inv.paid_amount, inv.currency)}</span>
                </div>
                <div className={cn("flex justify-between text-sm font-semibold px-3 py-1.5 rounded-md", balance > 0 ? "text-amber-600 dark:text-amber-400 bg-amber-500/10" : "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10")}>
                  <span>Balance Due</span>
                  <span>{fmt(balance, inv.currency)}</span>
                </div>
              </div>
            )}
          </div>



          {/* ── Discount Calculator ─────────────────────────────────────────────── */}
          {(editable || (inv.discount_amount ?? 0) > 0) && (
            <div className="bg-orange-500/5 rounded-xl border border-orange-500/20 overflow-hidden mb-6">
              <button
                onClick={() => {
                  if (!showDiscount) { setShowDiscount(true); loadDiscountCalc(inv.client_id, inv.id) }
                  else setShowDiscount(false)
                }}
                className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-foreground hover:bg-orange-500/10 transition-colors">
                <span className="flex items-center gap-2">
                  <Percent className="w-4 h-4 text-orange-500" />
                  Discount Calculator
                  {(inv.discount_amount ?? 0) > 0 && (
                    <span className="text-orange-600 dark:text-orange-400 font-medium ml-1">({fmt(inv.discount_amount, inv.currency)} applied)</span>
                  )}
                </span>
                {showDiscount ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
              </button>

              {showDiscount && (
                <div className="px-4 pb-4 space-y-4 border-t border-orange-500/20 pt-4 bg-background/50">
                  {discountLoading ? (
                    <div className="py-6 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                      <RefreshCw className="w-5 h-5 animate-spin text-orange-500/50" />
                      Analysing client history…
                    </div>
                  ) : discountCalc ? (
                    <>
                      {/* Client stats */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="bg-card rounded-xl p-3 border border-border/50 text-center shadow-sm">
                          <div className="text-[11px] text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Total Billed</div>
                          <div className="text-sm font-bold text-foreground">{fmt(discountCalc.totalBilled)}</div>
                        </div>
                        <div className="bg-card rounded-xl p-3 border border-border/50 text-center shadow-sm">
                          <div className="text-[11px] text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Payment Rate</div>
                          <div className={`text-sm font-bold ${discountCalc.paymentRate >= 0.95 ? 'text-emerald-500' : discountCalc.paymentRate >= 0.8 ? 'text-amber-500' : 'text-red-500'}`}>
                            {(discountCalc.paymentRate * 100).toFixed(0)}%
                          </div>
                        </div>
                        <div className="bg-card rounded-xl p-3 border border-border/50 text-center shadow-sm">
                          <div className="text-[11px] text-muted-foreground mb-1 uppercase tracking-wider font-semibold">Invoices</div>
                          <div className="text-sm font-bold text-foreground">{discountCalc.invoiceCount}</div>
                        </div>
                      </div>

                      {/* Suggestion */}
                      <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-3.5">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[11px] text-orange-600 dark:text-orange-400 font-bold uppercase tracking-wider flex items-center gap-1.5">
                            <Gift className="w-3.5 h-3.5" />Suggested Max Discount
                          </span>
                          <span className="text-sm font-black text-orange-600 dark:text-orange-400">{discountCalc.maxPct.toFixed(1)}%</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-orange-600/70 dark:text-orange-400/70 font-medium">Up to</span>
                          <span className="text-lg font-black text-orange-500">{fmt(discountCalc.suggestedMax, inv.currency)}</span>
                        </div>
                        {discountCalc.totalDiscGiven > 0 && (
                          <div className="text-[11px] text-orange-600/70 dark:text-orange-400/70 mt-2 font-medium">
                            Previously given: {fmt(discountCalc.totalDiscGiven)} across {discountCalc.discHistory.length} invoice(s)
                          </div>
                        )}
                      </div>

                      {/* Manual apply */}
                      {editable && (
                        <div className="space-y-3">
                          <div className="flex gap-3">
                            <div className="flex-1">
                              <label className="text-xs font-semibold text-foreground mb-1.5 block">Discount Amount ({getCurrencySymbol(inv.currency)})</label>
                              <input
                                type="number" min="0" max={discountCalc.thisTotal}
                                value={manualDiscount}
                                onChange={e => setManualDiscount(e.target.value)}
                                placeholder={`Max ${fmt(discountCalc.suggestedMax, inv.currency)}`}
                                className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-all"
                              />
                            </div>
                            <div className="text-center pt-8 text-xs font-medium text-muted-foreground w-16">
                              {manualDiscount && discountCalc.thisTotal > 0
                                ? `${((parseFloat(manualDiscount) / discountCalc.thisTotal) * 100).toFixed(1)}%`
                                : '—'}
                            </div>
                          </div>
                          <div>
                            <label className="text-xs font-semibold text-foreground mb-1.5 block">Reason (optional)</label>
                            <input
                              type="text"
                              value={discountReason}
                              onChange={e => setDiscountReason(e.target.value)}
                              placeholder="e.g. Loyalty discount, early payment…"
                              className="w-full bg-background border border-border/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 transition-all"
                            />
                          </div>
                          <div className="flex gap-3 pt-1">
                            <button
                              onClick={() => setManualDiscount(discountCalc.suggestedMax.toFixed(2))}
                              className="flex-1 py-2 text-xs font-semibold border border-orange-500/30 text-orange-600 dark:text-orange-400 rounded-lg hover:bg-orange-500/10 transition-colors">
                              Use Max ({fmt(discountCalc.suggestedMax, inv.currency)})
                            </button>
                            <button
                              onClick={() => applyDiscount(inv.id, inv.client_id)}
                              disabled={!manualDiscount}
                              className="flex-1 py-2 text-xs font-semibold bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white rounded-lg transition-colors shadow-sm">
                              Apply Discount
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Discount history */}
                      {discountCalc.discHistory.length > 0 && (
                        <div className="pt-2 border-t border-border/40 mt-2">
                          <div className="text-[11px] text-muted-foreground font-bold uppercase tracking-wider mb-2">Discount History</div>
                          <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                            {discountCalc.discHistory.slice(0, 5).map((d: any, i: number) => (
                              <div key={i} className="flex items-center justify-between text-xs p-2 bg-card rounded-lg border border-border/50 shadow-sm">
                                <span className="text-foreground font-medium truncate flex-1 mr-3">{d.reason || 'No reason'}</span>
                                <span className="text-orange-500 font-bold shrink-0">{fmt(d.discount_amount || 0)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              )}
            </div>
          )}

          {/* ── Change Log ──────────────────────────────────────────────────────── */}
          <div className="bg-secondary/20 rounded-xl border border-border/50 overflow-hidden mb-6">
            <button
              onClick={() => {
                if (!showChangeLogs) loadChangeLogs(inv.id)
                else setShowChangeLogs(false)
              }}
              className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold text-foreground hover:bg-secondary/30 transition-colors">
              <span className="flex items-center gap-2">
                <History className="w-4 h-4 text-blue-500" />Edit History
              </span>
              {showChangeLogs ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </button>
            {showChangeLogs && (
              <div className="px-4 pb-4 border-t border-border/50 pt-3 bg-background/30">
                {changeLogsLoading ? (
                  <div className="py-6 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
                    <RefreshCw className="w-5 h-5 animate-spin text-blue-500/50" />
                    Loading history…
                  </div>
                ) : changeLogs.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">No edits recorded yet</div>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {changeLogs.map((log: any) => (
                      <div key={log.id} className="p-3 bg-card rounded-xl border border-border/50 text-xs shadow-sm">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-blue-600 dark:text-blue-400 font-bold capitalize">{log.field_name.replace(/_/g, ' ')}</span>
                          <span className="text-muted-foreground font-medium">
                            {new Date(log.changed_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground mb-1.5">
                          <span className="line-through opacity-70 bg-red-500/10 text-red-600 dark:text-red-400 px-1.5 py-0.5 rounded">{log.old_value || '—'}</span>
                          <ChevronRight className="w-3 h-3 shrink-0" />
                          <span className="text-emerald-600 dark:text-emerald-400 font-medium bg-emerald-500/10 px-1.5 py-0.5 rounded">{log.new_value || '—'}</span>
                        </div>
                        <div className="text-[11px] text-muted-foreground/80 italic">{log.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Payment history */}
          {(() => {
            const payments = inv.payments || []
            const links = (inv.cashbook_invoice_allocations || []).filter(a => !a.deleted_at && a.cashbook_entry)
            
            // Standalone links are cashbook allocations that are NOT represented by a direct payment
            const standaloneLinks = links.filter(link => {
              return !payments.some(p => 
                p.payment_date === link.cashbook_entry!.entry_date &&
                (p.amount_inr || p.amount) === link.allocated_amount
              )
            })

            const hasAnyPayments = payments.length > 0 || standaloneLinks.length > 0

            if (!hasAnyPayments) return null

            return (
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-foreground tracking-tight flex items-center gap-1.5 mb-3">
                  <span className="text-emerald-500">Payments Received</span>
                  <span className="text-muted-foreground font-normal ml-0.5">({payments.length + standaloneLinks.length})</span>
                </h4>
                <div className="space-y-2">
                  {/* Direct Payments */}
                  {payments.map(p => (
                    <div key={p.id} className="flex items-center justify-between p-3 bg-emerald-500/5 rounded-xl border border-emerald-500/20 text-sm hover:border-emerald-500/40 hover:shadow-sm transition-all group">
                      <div>
                        <div className="font-bold text-emerald-600 dark:text-emerald-400 mb-1">{fmt(p.amount, (p.currency as Currency) || inv.currency)}</div>
                        <div className="text-xs text-muted-foreground font-medium flex flex-wrap items-center gap-1.5">
                          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{fmtDate(p.payment_date)}</span>
                          <span className="w-1 h-1 rounded-full bg-border"></span>
                          <span className="px-1.5 py-0.5 rounded-md bg-secondary text-secondary-foreground">{METHOD_LABEL[p.payment_method] || p.payment_method}</span>
                          {p.reference && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-border"></span>
                              <span className="font-mono text-[11px] bg-secondary/50 px-1 rounded">{p.reference}</span>
                            </>
                          )}
                          {p.currency && p.currency !== 'INR' && p.amount_inr != null && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-border"></span>
                              <span>@ {p.exchange_rate} = {fmt(p.amount_inr, 'INR')}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-2 shrink-0">
                        <button
                          onClick={() => setReceiptPayment({ pmt: p, invoice: inv })}
                          title="Get / share receipt"
                          className="p-1.5 rounded-lg hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-500 transition-all"
                        >
                          <Receipt className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => deletePayment(inv.id, p.id)}
                          title="Remove this payment"
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Cash Book Allocations */}
                  {standaloneLinks.map(a => (
                    <div key={a.id} className="flex items-center justify-between p-3 bg-violet-500/5 rounded-xl border border-violet-500/20 text-sm hover:border-violet-500/40 hover:shadow-sm transition-all group">
                      <div>
                        <div className="font-bold text-emerald-600 dark:text-emerald-400 mb-1">
                          ₹{Number(a.allocated_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </div>
                        <div className="text-xs text-muted-foreground font-medium flex flex-wrap items-center gap-1.5">
                          <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{fmtDate(a.cashbook_entry!.entry_date)}</span>
                          <span className="w-1 h-1 rounded-full bg-border"></span>
                          <span className="text-violet-600 dark:text-violet-400">Cash Book Allocation</span>
                          {a.cashbook_entry!.reference && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-border"></span>
                              <span className="font-mono text-[11px] bg-secondary/50 px-1 rounded">{a.cashbook_entry!.reference}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <a
                        href={`/dashboard/cashbook?client=${inv.client_id}&focus=${a.cashbook_entry!.id}`}
                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-violet-500/10 text-muted-foreground hover:text-violet-500 transition-all ml-2 shrink-0"
                        title="View in Cash Book"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Notes */}
          {inv.notes && (
            <div className="mb-6">
               <h4 className="text-sm font-semibold text-foreground tracking-tight flex items-center gap-1.5 mb-3">
                 <FileText className="w-4 h-4 text-muted-foreground" /> Notes
               </h4>
              <div className="text-sm text-muted-foreground bg-secondary/30 rounded-xl p-4 border border-border/50 leading-relaxed shadow-sm">
                {inv.notes}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Payment Form
  // ─────────────────────────────────────────────────────────────────────────
  function renderPayPanel(inv: Invoice) {
    const balance = balanceDue(inv)
    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">
        <div className="px-5 py-4 border-b border-border/50 flex items-center justify-between bg-card">
          <div>
            <h3 className="font-bold text-base text-foreground tracking-tight">Record Payment</h3>
            <div className="text-xs text-muted-foreground font-medium mt-0.5">{inv.invoice_number} · Balance <span className="text-foreground">{fmt(balance, inv.currency)}</span></div>
          </div>
          <button onClick={() => setPanelMode('detail')} aria-label="Close panel" className="p-2 hover:bg-secondary/80 rounded-xl text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Amount + currency + rate (3-way synced) */}
          <div className="bg-card border border-border/50 rounded-xl p-4 shadow-sm">
            <label className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2.5 flex items-center gap-1.5"><CreditCard className="w-3.5 h-3.5" /> Amount</label>
            {balance > 0 && (
              <div className="flex gap-2 mb-3 flex-wrap">
                {[balance, balance / 2].filter(v => v > 0).map((v, i) => (
                  <button key={i}
                    onClick={() => setPayForm(p => {
                      const fx = payFx(v.toFixed(2), p.currency, p.rate)
                      return { ...p, amount: v.toFixed(2), rate: fx.rate, amountInr: fx.amountInr, rateSource: fx.rateSource }
                    })}
                    className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-all ${parseFloat(payForm.amount) === v ? 'bg-violet-500/10 border-violet-500/40 text-violet-600 dark:text-violet-400' : 'border-border/60 text-muted-foreground hover:bg-secondary/50 hover:border-border hover:text-foreground'}`}>
                    {i === 0 ? 'Full' : 'Half'} {fmt(v, inv.currency)}
                  </button>
                ))}
              </div>
            )}
            <CurrencyAmountInput
              value={{ currency: payForm.currency, amount: payForm.amount, rate: payForm.rate, amountInr: payForm.amountInr, rateSource: payForm.rateSource }}
              onChange={fx => setPayForm(p => ({ ...p, currency: fx.currency, amount: fx.amount, rate: fx.rate, amountInr: fx.amountInr, rateSource: fx.rateSource }))}
              ratesMap={rateMap}
              amountLabel="Payment"
              rateDate={exchangeRates.find(r => r.currency === payForm.currency)?.rate_date}
            />
            {payForm.currency !== inv.currency && (
              <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400 font-medium bg-amber-500/10 p-2 rounded-lg border border-amber-500/20">
                Paying in {payForm.currency} on a {inv.currency} invoice — the balance is reduced by the ₹ value converted at the invoice rate.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Date</label>
              <input type="date" value={payForm.payment_date}
                onChange={e => setPayForm(p => ({ ...p, payment_date: e.target.value }))}
                className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
              />
            </div>
            {bankAccounts.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">Bank Account <span className="text-muted-foreground font-normal">(optional)</span></label>
                <AppSelect value={payForm.bank_account_id}
                  onChange={e => setPayForm(p => ({ ...p, bank_account_id: e.target.value }))}>
                  <option value="">— none —</option>
                  {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </AppSelect>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground block">Method</label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => (
                <button key={m}
                  onClick={() => setPayForm(p => ({ ...p, payment_method: m }))}
                  className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-all shadow-sm ${payForm.payment_method === m ? 'bg-violet-500 border-violet-600 text-white shadow-violet-500/20' : 'bg-card border-border/60 text-muted-foreground hover:bg-secondary hover:border-border hover:text-foreground'}`}>
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Reference <span className="text-muted-foreground font-normal">(optional)</span></label>
              <input type="text" value={payForm.reference}
                onChange={e => setPayForm(p => ({ ...p, reference: e.target.value }))}
                placeholder="Txn ID / cheque number…"
                className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
              <input type="text" value={payForm.notes}
                onChange={e => setPayForm(p => ({ ...p, notes: e.target.value }))}
                placeholder="Any notes about this payment…"
                className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
              />
            </div>
          </div>

          {/* Live balance remaining */}
          {(() => {
            // Reduction to the balance, expressed in the invoice currency.
            const invRate = (inv.exchange_rate && inv.exchange_rate > 0) ? inv.exchange_rate : (rateMap[inv.currency] || 1)
            const entered = payForm.currency === inv.currency
              ? (parseFloat(payForm.amount) || 0)
              : round2((parseFloat(payForm.amountInr) || 0) / (invRate || 1))
            const after   = balance - entered
            if (entered <= 0) return null
            return (
              <div className={`flex items-center justify-between px-4 py-3 rounded-xl border text-sm font-bold transition-all shadow-sm ${
                after <= 0
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                  : 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400'
              }`}>
                <span className="flex items-center gap-1.5">{after <= 0 ? <CheckCircle className="w-4 h-4" /> : null}{after <= 0 ? 'Fully paid' : 'Remaining after payment'}</span>
                <span className="tabular-nums">
                  {after <= 0 ? fmt(0, inv.currency) : fmt(after, inv.currency)}
                </span>
              </div>
            )
          })()}

          {/* Advance payment toggle */}
          <div className={`flex items-start gap-3 p-4 rounded-xl border transition-all cursor-pointer shadow-sm ${isAdvancePayment ? 'bg-amber-500/10 border-amber-500/30' : 'bg-card border-border/50 hover:border-border/80'}`}
            onClick={() => setIsAdvancePayment(p => !p)}>
            <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${isAdvancePayment ? 'bg-amber-500 border-amber-600' : 'border-border/80'}`}>
              {isAdvancePayment && <Check className="w-3 h-3 text-white stroke-[3]" />}
            </div>
            <div>
              <div className="text-sm font-bold text-foreground flex items-center gap-1.5 mb-1">
                <Tag className="w-4 h-4 text-amber-500" />Advance / Excess Payment
              </div>
              <div className="text-xs text-muted-foreground font-medium leading-relaxed">
                Mark this as an advance or accidental excess payment. It will be noted in payment records for future adjustment.
              </div>
              {isAdvancePayment && (
                <div className="mt-2.5 text-[11px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-600 dark:text-amber-400 px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5" /> Exceeds balance due
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => handlePayment(inv.id)}
            disabled={saving || !payForm.amount}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold rounded-xl flex items-center justify-center gap-2 transition-all shadow-sm">
            <CreditCard className="w-4 h-4" />
            {saving ? 'Saving…' : isAdvancePayment ? `Record Advance ${payForm.amount ? fmt(parseFloat(payForm.amount), inv.currency) : ''}` : `Record ${payForm.amount ? fmt(parseFloat(payForm.amount), inv.currency) : 'Payment'}`}
          </button>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — New Invoice Form
  // ─────────────────────────────────────────────────────────────────────────
  function renderNewPanel() {
    function updateNewItem(idx: number, field: string, val: any) {
      setNewForm(prev => {
        const items = [...prev.items]
        items[idx] = { ...items[idx], [field]: val }
        if (field === 'quantity' || field === 'unit_price') {
          items[idx].total = items[idx].quantity * items[idx].unit_price
        }
        return { ...prev, items }
      })
    }
    const total = newForm.items.reduce((s, i) => s + (i.total || 0), 0)

    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">
        <div className="px-5 py-4 border-b border-border/50 flex items-center justify-between bg-card">
          <div>
            <h3 className="font-bold text-base text-foreground tracking-tight flex items-center gap-2">
              <FileText className="w-4 h-4 text-violet-500" />
              Manual Invoice
            </h3>
            <p className="text-[11px] text-muted-foreground font-medium mt-1 leading-tight">For one-off / override invoices. Tasks auto-generate drafts.</p>
          </div>
          <button onClick={() => setPanelMode('detail')} aria-label="Close panel" className="p-2 hover:bg-secondary/80 rounded-xl text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        {/* Unsaved changes banner */}
        {newFormDirty && (
          <div className="flex items-center gap-2 px-5 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs font-bold uppercase tracking-wider">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Unsaved changes — navigating away will lose this form</span>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Client <span className="text-red-500">*</span></label>
            <Combobox
              options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
              value={newForm.client_id}
              onChange={v => setNewForm(p => ({ ...p, client_id: v }))}
              placeholder="Select client…"
              sortKey="clients"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Issue Date</label>
              <input type="date" value={newForm.issue_date}
                onChange={e => setNewForm(p => ({ ...p, issue_date: e.target.value }))}
                className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Due Date</label>
              <input type="date" value={newForm.due_date}
                onChange={e => setNewForm(p => ({ ...p, due_date: e.target.value }))}
                className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
              />
            </div>
          </div>

          {/* Line items */}
          <div className="bg-card border border-border/50 rounded-xl p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <label className="text-xs font-semibold text-foreground uppercase tracking-wider">Line Items</label>
              <button onClick={() => setNewForm(p => ({ ...p, items: [...p.items, { description: '', quantity: 1, unit_price: 0, total: 0, service_id: '' }] }))}
                className="text-xs font-bold text-violet-600 dark:text-violet-400 hover:text-violet-500 flex items-center gap-1 px-2 py-1 hover:bg-violet-500/10 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5" />Add row
              </button>
            </div>
            <div className="space-y-2.5">
              {newForm.items.map((item, idx) => (
                <div key={idx} className="flex gap-2 items-start group">
                  <input value={item.description} onChange={e => updateNewItem(idx, 'description', e.target.value)}
                    placeholder="Description…"
                    className="flex-1 bg-background border border-border/50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all"
                  />
                  <div className="relative">
                    <span className="absolute left-2.5 top-2 text-muted-foreground text-sm font-medium">{getCurrencySymbol(newForm.currency as any)}</span>
                    <input type="number" value={item.unit_price || ''} onChange={e => updateNewItem(idx, 'unit_price', parseFloat(e.target.value) || 0)}
                      placeholder="0.00"
                      className="w-24 bg-background border border-border/50 rounded-lg pl-7 pr-3 py-2 text-sm text-right focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all font-medium"
                    />
                  </div>
                  {newForm.items.length > 1 && (
                    <button aria-label="Remove line" onClick={() => setNewForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) }))}
                      className="p-2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            
            <div className="flex justify-between items-center text-sm font-bold border-t border-border/50 pt-4 mt-4 text-foreground">
              <span className="uppercase tracking-wider text-xs text-muted-foreground">Total Amount</span>
              <span className="text-base text-violet-600 dark:text-violet-400">{fmt(total)}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
            <textarea value={newForm.notes} onChange={e => setNewForm(p => ({ ...p, notes: e.target.value }))}
              rows={2} placeholder="Optional notes for this invoice…"
              className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
            />
          </div>

          <button onClick={createManualInvoice} disabled={saving || !newForm.client_id}
            className="w-full py-3 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-bold rounded-xl flex items-center justify-center gap-2 transition-all shadow-sm hover:shadow-violet-500/25 disabled:hover:shadow-none mt-2">
            <FileText className="w-4 h-4" />
            {saving ? 'Creating…' : 'Create Invoice'}
          </button>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Generate Invoice (date range / specific day)
  // ─────────────────────────────────────────────────────────────────────────
  function renderGeneratePanel() {
    const selectedCount = genTasks.filter(t => genSelectedIds.has(t.id)).length
    const selectedTotal = genTasks.filter(t => genSelectedIds.has(t.id)).reduce((s, t) => s + (t.billing_amount ?? t.billing_amount_inr ?? 0), 0)
    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">
        <div className="px-5 py-4 border-b border-border/50 flex items-center justify-between bg-card">
          <div>
            <h3 className="font-bold text-base text-foreground tracking-tight flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-500" />
              Generate Invoice
            </h3>
            <p className="text-[11px] text-muted-foreground font-medium mt-1 leading-tight">Pick a client + period → fetch done tasks → create invoice</p>
          </div>
          <button onClick={() => { setPanelMode('detail'); setGenTasks([]) }} aria-label="Close panel" className="p-2 hover:bg-secondary/80 rounded-xl text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

          {/* Client */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Client <span className="text-red-500">*</span></label>
            <Combobox
              options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
              value={genForm.client_id}
              onChange={v => { setGenForm(p => ({ ...p, client_id: v })); setGenTasks([]) }}
              placeholder="Select client…"
              sortKey="clients"
            />
          </div>

          {/* Mode toggle */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-foreground">Period Type</label>
            <div className="flex gap-2">
              {(['range', 'day'] as const).map(m => (
                <button key={m} onClick={() => setGenForm(p => ({ ...p, mode: m }))}
                  className={`flex-1 py-2 text-sm font-medium rounded-xl border transition-all shadow-sm ${genForm.mode === m ? 'bg-violet-500 border-violet-600 text-white shadow-violet-500/20' : 'bg-card border-border/60 text-muted-foreground hover:bg-secondary hover:border-border hover:text-foreground'}`}>
                  {m === 'range' ? '📅 Date Range' : '📌 Specific Day'}
                </button>
              ))}
            </div>
          </div>

          {/* Date inputs */}
          {genForm.mode === 'range' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">From</label>
                <input type="date" value={genForm.date_from}
                  onChange={e => setGenForm(p => ({ ...p, date_from: e.target.value }))}
                  className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">To</label>
                <input type="date" value={genForm.date_to}
                  onChange={e => setGenForm(p => ({ ...p, date_to: e.target.value }))}
                  className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">Date</label>
              <input type="date" value={genForm.specific_date}
                onChange={e => setGenForm(p => ({ ...p, specific_date: e.target.value }))}
                className="w-full bg-card border border-border/50 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20 transition-all shadow-sm"
              />
            </div>
          )}

          {/* Fetch button */}
          <button onClick={fetchGenTasks} disabled={genLoading || !genForm.client_id}
            className="w-full py-3 bg-secondary hover:bg-secondary/80 border border-border/50 text-sm font-bold text-foreground rounded-xl flex items-center justify-center gap-2 transition-all shadow-sm disabled:opacity-50 mt-2">
            <Search className="w-4 h-4 text-muted-foreground" />
            {genLoading ? 'Fetching…' : 'Fetch Done Tasks'}
          </button>

          {/* Task list */}
          {genTasks.length > 0 && (
            <div className="bg-card border border-border/50 rounded-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Found {genTasks.length} task{genTasks.length !== 1 ? 's' : ''}
                </span>
                <div className="flex gap-2 text-xs font-bold text-violet-600 dark:text-violet-400">
                  <button className="hover:text-violet-500 transition-colors" onClick={() => setGenSelectedIds(new Set(genTasks.map(t => t.id)))}>All</button>
                  <span className="text-border">|</span>
                  <button className="hover:text-violet-500 transition-colors" onClick={() => setGenSelectedIds(new Set())}>None</button>
                </div>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {genTasks.map(task => {
                    const existInvs: any[] = (task as any).existing_invoices || []
                    const activeConflict = existInvs.filter((inv: any) => inv.status !== 'cancelled')
                    const hasConflict = activeConflict.length > 0
                    return (
                  <label key={task.id} className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all shadow-sm
                    ${hasConflict ? 'bg-amber-500/10 border-amber-500/30' : genSelectedIds.has(task.id) ? 'bg-violet-500/10 border-violet-500/40 shadow-violet-500/5' : 'bg-background border-border/50 hover:border-border/80'}`}>
                    <input type="checkbox" checked={genSelectedIds.has(task.id)}
                      onChange={e => setGenSelectedIds(prev => {
                        const n = new Set(prev)
                        e.target.checked ? n.add(task.id) : n.delete(task.id)
                        return n
                      })}
                      className="accent-violet-500 mt-1 cursor-pointer w-4 h-4"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate text-foreground">{task.title}</div>
                      <div className="text-xs text-muted-foreground font-medium mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{fmtDate(task.task_date)}</span>
                        {task.service?.name && (
                           <>
                             <span className="w-1 h-1 rounded-full bg-border"></span>
                             <span>{task.service.name}</span>
                           </>
                        )}
                        {task.status === 'invoiced' && (
                          <>
                             <span className="w-1 h-1 rounded-full bg-border"></span>
                             <span className="text-amber-500 font-bold">invoiced</span>
                          </>
                        )}
                      </div>
                      {hasConflict && (
                        <div className="mt-2 space-y-1">
                          {activeConflict.map((inv: any) => (
                            <div key={inv.id} className="text-[10px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 bg-amber-500/20 border border-amber-500/30 rounded-lg px-2 py-1 inline-flex items-center gap-1.5 mr-1.5 mb-1">
                              <AlertTriangle className="w-3 h-3" /> Already in {inv.invoice_number} ({inv.status})
                            </div>
                          ))}
                          <div className="text-[11px] text-muted-foreground font-medium">Including will create a duplicate line item</div>
                        </div>
                      )}
                    </div>
                    <span className="text-sm font-bold shrink-0 text-foreground">{fmt(task.billing_amount ?? task.billing_amount_inr ?? 0, task.currency || 'INR')}</span>
                  </label>
                    )
                  })}
              </div>

              {/* Summary + create */}
              <div className="mt-4 pt-4 border-t border-border/50 space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-semibold text-muted-foreground">{selectedCount} item{selectedCount !== 1 ? 's' : ''} selected</span>
                  <span className="text-base font-bold text-violet-600 dark:text-violet-400">{fmt(selectedTotal)}</span>
                </div>
                <button onClick={createFromGenTasks} disabled={saving || selectedCount === 0}
                  className="w-full py-3 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-bold rounded-xl flex items-center justify-center gap-2 transition-all shadow-sm hover:shadow-violet-500/25 disabled:hover:shadow-none">
                  <FileText className="w-4 h-4" />
                  {saving ? 'Creating…' : `Create Invoice · ${fmt(selectedTotal)}`}
                </button>
              </div>
            </div>
          )}

          {genTasks.length === 0 && !genLoading && genForm.client_id && (
            <div className="text-sm font-medium text-muted-foreground text-center py-12 bg-secondary/30 rounded-2xl border border-dashed border-border/60">
              Click <span className="font-bold text-foreground">&quot;Fetch Done Tasks&quot;</span> to see available tasks
            </div>
          )}
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Batch Generate (Historical)
  // ─────────────────────────────────────────────────────────────────────────
  function renderBatchGeneratePanel() {
    // ── Apply filters + sort to raw groups ────────────────────────────────
    const minAmt = parseFloat(batchFilterMinAmount) || 0
    const visibleGroups = batchGroups
      .filter(g => {
        if (batchFilterClient && !g.client_name.toLowerCase().includes(batchFilterClient.toLowerCase())) return false
        if (batchFilterMonthFrom && g.month < batchFilterMonthFrom) return false
        if (batchFilterMonthTo   && g.month > batchFilterMonthTo)   return false
        if (minAmt > 0 && g.total < minAmt) return false
        return true
      })
      .sort((a, b) => {
        if (batchSortBy === 'client_asc')  return a.client_name.localeCompare(b.client_name) || a.month.localeCompare(b.month)
        if (batchSortBy === 'month_desc')  return b.month.localeCompare(a.month) || a.client_name.localeCompare(b.client_name)
        if (batchSortBy === 'amount_desc') return b.total - a.total
        // month_asc (default)
        return a.month.localeCompare(b.month) || a.client_name.localeCompare(b.client_name)
      })

    const selectedGroups = visibleGroups.filter(g => batchSelected.has(g.key))
    const totalInvoices  = selectedGroups.length
    const totalAmount    = selectedGroups.reduce((s, g) => s + g.total, 0)

    const hasFilters = batchFilterClient || batchFilterMonthFrom || batchFilterMonthTo || batchFilterMinAmount
    const clearFilters = () => { setBatchFilterClient(''); setBatchFilterMonthFrom(''); setBatchFilterMonthTo(''); setBatchFilterMinAmount('') }

    return (
      <div className="flex flex-col h-full bg-background overflow-hidden">

        {/* Header */}
        <div className="px-5 py-4 border-b border-border/50 flex items-center justify-between bg-card">
          <div>
            <h3 className="font-bold text-base text-foreground tracking-tight flex items-center gap-2">
              <History className="w-4 h-4 text-emerald-500" />Batch Generate
            </h3>
            <p className="text-[11px] text-muted-foreground font-medium mt-1 leading-tight">Historical scan of un-invoiced done tasks</p>
          </div>
          <button onClick={() => { setPanelMode('detail'); setBatchGroups([]) }} aria-label="Close panel" className="p-2 hover:bg-secondary/80 rounded-xl text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scan prompt */}
        {batchGroups.length === 0 && !batchLoading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 text-center bg-secondary/30">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 shadow-inner">
              <History className="w-8 h-8 text-emerald-500/60" />
            </div>
            <p className="text-sm font-medium text-muted-foreground max-w-[240px] leading-relaxed">
              Scans all <strong>Done</strong> tasks without an active invoice, then groups them by client and billing month.
            </p>
            <button onClick={fetchBatchGroups}
              className="px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl transition-all shadow-sm hover:shadow-emerald-500/25">
              Scan Un-invoiced Tasks
            </button>
          </div>
        )}

        {batchLoading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground bg-secondary/30">
            <RefreshCw className="w-6 h-6 animate-spin text-emerald-500/50" />
            <span className="text-sm font-semibold">Scanning tasks…</span>
          </div>
        )}

        {!batchLoading && batchGroups.length > 0 && (
          <>
            {/* ── Filter bar ─────────────────────────────────────────────── */}
            <div className="px-5 pt-4 pb-3 border-b border-border/50 space-y-3 bg-card shadow-sm z-10 relative">

              {/* Row 1: Client search + Sort */}
              <div className="flex gap-3">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="text" placeholder="Filter by client…" value={batchFilterClient}
                    onChange={e => setBatchFilterClient(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border/50 rounded-xl focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all shadow-sm"
                  />
                </div>
                <select value={batchSortBy} onChange={e => setBatchSortBy(e.target.value as any)}
                  className="text-sm bg-background border border-border/50 rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 text-foreground font-medium shadow-sm cursor-pointer">
                  <option value="month_asc">Month ↑</option>
                  <option value="month_desc">Month ↓</option>
                  <option value="client_asc">Client A→Z</option>
                  <option value="amount_desc">Amount ↓</option>
                </select>
              </div>

              {/* Row 2: Month range */}
              <div className="flex gap-3 items-center">
                <Calendar className="w-4 h-4 text-emerald-500/70 shrink-0" />
                <div className="flex gap-2 flex-1">
                  <input type="month" value={batchFilterMonthFrom}
                    onChange={e => setBatchFilterMonthFrom(e.target.value)}
                    className="flex-1 text-sm font-medium bg-background border border-border/50 rounded-xl px-3 py-1.5 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 text-foreground transition-all shadow-sm"
                    title="From month"
                  />
                  <span className="text-muted-foreground/50 text-sm font-medium self-center">→</span>
                  <input type="month" value={batchFilterMonthTo}
                    onChange={e => setBatchFilterMonthTo(e.target.value)}
                    className="flex-1 text-sm font-medium bg-background border border-border/50 rounded-xl px-3 py-1.5 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 text-foreground transition-all shadow-sm"
                    title="To month"
                  />
                </div>
                <div className="relative">
                  <IndianRupee className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                  <input type="number" placeholder="Min ₹" value={batchFilterMinAmount}
                    onChange={e => setBatchFilterMinAmount(e.target.value)}
                    className="w-24 pl-7 pr-3 py-1.5 text-sm font-medium bg-background border border-border/50 rounded-xl focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all shadow-sm"
                    title="Minimum invoice amount"
                  />
                </div>
                {hasFilters && (
                  <button onClick={clearFilters} aria-label="Clear all filters" className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors" title="Clear all filters">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Quick month shortcuts */}
              <div className="flex gap-2 flex-wrap">
                {[
                  { label: '2023', from: '2023-01', to: '2023-12' },
                  { label: '2024', from: '2024-01', to: '2024-12' },
                  { label: '2025', from: '2025-01', to: '2025-12' },
                  { label: 'Q1 \'25', from: '2025-01', to: '2025-03' },
                  { label: 'Q2 \'25', from: '2025-04', to: '2025-06' },
                  { label: 'Q3 \'25', from: '2025-07', to: '2025-09' },
                  { label: 'Q4 \'25', from: '2025-10', to: '2025-12' },
                ].map(({ label, from, to }) => {
                  const active = batchFilterMonthFrom === from && batchFilterMonthTo === to
                  return (
                    <button key={label}
                      onClick={() => { setBatchFilterMonthFrom(active ? '' : from); setBatchFilterMonthTo(active ? '' : to) }}
                      className={`text-xs font-bold px-2.5 py-1 rounded-lg border transition-all ${active ? 'bg-emerald-500 border-emerald-600 text-white shadow-emerald-500/20' : 'bg-background border-border/50 text-muted-foreground hover:bg-secondary hover:border-border hover:text-foreground shadow-sm'}`}>
                      {label}
                    </button>
                  )
                })}
              </div>

              {/* Summary + select controls */}
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  {visibleGroups.length} / {batchGroups.length} groups
                  {hasFilters && <span className="text-amber-500 ml-1.5">(filtered)</span>}
                </span>
                <div className="flex gap-3 text-xs font-bold text-emerald-600 dark:text-emerald-400">
                  <button className="hover:text-emerald-500 transition-colors" onClick={() => {
                    const next = new Set(batchSelected)
                    visibleGroups.forEach(g => next.add(g.key))
                    setBatchSelected(next)
                  }}>Select visible</button>
                  <span className="text-border">|</span>
                  <button className="hover:text-emerald-500 transition-colors" onClick={() => {
                    const next = new Set(batchSelected)
                    visibleGroups.forEach(g => next.delete(g.key))
                    setBatchSelected(next)
                  }}>Deselect visible</button>
                  <span className="text-border">|</span>
                  <button onClick={fetchBatchGroups} className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors ml-2 bg-secondary hover:bg-secondary/80 px-2 py-1 rounded-md border border-border/50">
                    <RefreshCw className="w-3 h-3" />Rescan
                  </button>
                </div>
              </div>
            </div>

            {/* ── Groups list ─────────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
              {visibleGroups.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm font-medium bg-secondary/30 rounded-2xl border border-dashed border-border/60">
                  No groups match the current filters
                </div>
              ) : visibleGroups.map(group => {
                const checked  = batchSelected.has(group.key)
                const expanded = batchExpandedKey === group.key
                const [year, mon] = group.month.split('-')
                const monthLabel = new Date(`${group.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
                // Invoice is issued on the 1st of the NEXT month (billing cycle)
                const invoiceIssueDate = getInvoiceDateForTaskMonth(group.month)
                const invoiceYYMM = toSequenceMonth(invoiceIssueDate)
                const groupTasks = group.tasks || []
                return (
                  <div key={group.key}
                    className={`rounded-xl border transition-all shadow-sm ${checked ? 'bg-emerald-500/5 border-emerald-500/40 shadow-emerald-500/5' : 'bg-card border-border/50 hover:border-border/80'}`}>

                    {/* ── Group header row ── */}
                    <div className="flex items-center gap-3 p-3">
                      <input type="checkbox" checked={checked}
                        onChange={e => {
                          const next = new Set(batchSelected)
                          if (e.target.checked) next.add(group.key); else next.delete(group.key)
                          setBatchSelected(next)
                        }}
                        className="w-4 h-4 accent-emerald-500 cursor-pointer shrink-0"
                      />
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setBatchExpandedKey(expanded ? null : group.key)}>
                        <div className="text-sm font-semibold truncate text-foreground">{group.client_name}</div>
                        <div className="text-xs font-medium text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                          <span className="text-foreground/80 bg-secondary px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider">{monthLabel}</span>
                          <span className="w-1 h-1 rounded-full bg-border"></span>
                          <span>{group.taskCount} task{group.taskCount !== 1 ? 's' : ''}</span>
                          {(group.expenses || []).length > 0 && (
                            <>
                              <span className="w-1 h-1 rounded-full bg-border"></span>
                              <span className="text-amber-500 font-bold">{group.expenses!.length} expense{group.expenses!.length > 1 ? 's' : ''}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{fmt(group.total + (group.expenses || []).reduce((s, e) => s + e.amount_inr, 0), group.currency as any)}</div>
                        <div className="text-[11px] font-mono font-medium text-muted-foreground mt-0.5">INV-{invoiceYYMM}-NNN</div>
                      </div>
                      {/* Expand toggle */}
                      <button
                        onClick={() => setBatchExpandedKey(expanded ? null : group.key)}
                        title={expanded ? 'Collapse tasks' : 'Preview tasks'}
                        className={`shrink-0 p-1.5 rounded-lg transition-colors ${expanded ? 'text-emerald-500 bg-emerald-500/10' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'}`}>
                        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>

                    {/* ── Expanded task list ── */}
                    {expanded && (
                      <div className="border-t border-border/50 mx-3 mb-3 pt-3 space-y-1">
                        {groupTasks.length === 0 ? (
                          <p className="text-xs font-medium text-muted-foreground px-2 py-2 bg-secondary/50 rounded-lg text-center">No task details available</p>
                        ) : groupTasks.map((t, i) => (
                          <div key={t.id}
                            className="flex items-center gap-3 px-3 py-2 rounded-lg bg-background hover:bg-secondary/50 transition-colors group border border-transparent hover:border-border/50">
                            <span className="text-[10px] font-bold text-muted-foreground/50 font-mono w-4 text-right shrink-0">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-semibold text-foreground/90 truncate">{t.title}</div>
                              <div className="text-[10px] font-medium text-muted-foreground mt-0.5 flex items-center gap-1">
                                <Calendar className="w-3 h-3 text-muted-foreground/70" />
                                {t.task_date ? new Date(t.task_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
                              </div>
                            </div>
                            <div className="text-xs font-bold text-foreground/80 shrink-0 tabular-nums">
                              {t.billing_amount_inr > 0 ? fmt(t.billing_amount_inr, t.currency as any) : <span className="text-muted-foreground/40 font-normal">—</span>}
                            </div>
                          </div>
                        ))}
                        {/* Expense entries for this month */}
                        {(group.expenses || []).map(exp => (
                          <div key={exp.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-500/20">
                            <span className="text-[10px] font-bold text-amber-500/50 font-mono w-4 text-right shrink-0 flex justify-center">
                              <ShoppingBag className="w-3 h-3" />
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-bold text-amber-600 dark:text-amber-400 truncate">{exp.description || 'Expense'}</div>
                              <div className="text-[10px] font-medium text-muted-foreground mt-0.5 flex items-center gap-1">
                                <Calendar className="w-3 h-3 text-muted-foreground/70" />
                                {exp.entry_date ? new Date(exp.entry_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
                              </div>
                            </div>
                            <div className="text-xs font-bold text-amber-600 dark:text-amber-400 shrink-0 tabular-nums">
                              {fmt(exp.amount_inr, 'INR')}
                            </div>
                          </div>
                        ))}
                        {/* Group total */}
                        <div className="flex items-center justify-between px-3 pt-2.5 mt-2 border-t border-border/50">
                          <span className="text-xs font-semibold text-muted-foreground">{groupTasks.length} tasks{(group.expenses || []).length > 0 ? ` + ${group.expenses!.length} expense${group.expenses!.length > 1 ? 's' : ''}` : ''} · subtotal</span>
                          <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">{fmt(group.total + (group.expenses || []).reduce((s, e) => s + e.amount_inr, 0), group.currency as any)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ── Progress bar (while generating) ────────────────────────── */}
            {batchGenerating && (
              <div className="px-5 pb-4 pt-2">
                <div className="bg-card border border-border/50 rounded-xl p-4 shadow-sm relative overflow-hidden">
                  <div className="absolute inset-0 bg-emerald-500/5 animate-pulse"></div>
                  <div className="flex items-center justify-between mb-3 text-xs font-bold text-foreground relative z-10">
                    <span className="flex items-center gap-1.5"><RefreshCw className="w-3.5 h-3.5 text-emerald-500 animate-spin" /> Generating invoices…</span>
                    <span className="text-emerald-600 dark:text-emerald-400">{batchDone} / {totalInvoices}</span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden relative z-10">
                    <div className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                      style={{ width: totalInvoices > 0 ? `${Math.round((batchDone / totalInvoices) * 100)}%` : '0%' }} />
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        {!batchLoading && batchGroups.length > 0 && (
          <div className="px-5 py-4 border-t border-border/50 flex items-center justify-between gap-4 bg-card">
            <div className="text-xs font-medium text-muted-foreground">
              <span className="font-bold text-foreground text-sm">{totalInvoices}</span> selected
              {totalInvoices > 0 && <span className="ml-2 font-bold text-emerald-600 dark:text-emerald-400 text-sm">{fmt(totalAmount)}</span>}
            </div>
            <button onClick={runBatchGenerate} disabled={batchGenerating || totalInvoices === 0}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-xl transition-all shadow-sm hover:shadow-emerald-500/25 disabled:opacity-50 disabled:hover:shadow-none disabled:cursor-not-allowed">
              <Zap className="w-4 h-4" />
              {batchGenerating ? `Creating… (${batchDone}/${totalInvoices})` : `Generate ${totalInvoices} Invoice${totalInvoices !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Statement Generator
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Discount Analytics
  // ─────────────────────────────────────────────────────────────────────────
  function renderDiscountsPanel() {
    // ── Discount tab data ──────────────────────────────────────────────────
    const discRows = discFilterClient
      ? discAnalytics.filter((d: any) => d.client?.id === discFilterClient)
      : discAnalytics
    const totalDiscGiven = discRows.reduce((s: number, d: any) => s + (d.discount_amount || 0), 0)
    const avgDiscPct     = discRows.length > 0
      ? discRows.reduce((s: number, d: any) => s + (d.discount_percentage || 0), 0) / discRows.length : 0
    const discClients = Array.from(new Map(
      discAnalytics.filter((d: any) => d.client).map((d: any) => [d.client.id, d.client])
    ).values())

    // ── Bad debt tab data (from invoices already in state) ─────────────────
    const badDebtInvoices = invoices.filter(i => i.status === 'bad_debt')
    // Grand totals across all clients/currencies → INR. (Per-client rows below
    // keep their own currency.)
    const totalBadDebt    = badDebtInvoices.reduce((s, i) => s + invTotalInr(i), 0)
    const badDebtUnpaid   = badDebtInvoices.reduce((s, i) => s + balanceDueInr(i), 0)
    const bdByClient      = Object.values(
      badDebtInvoices.reduce((map: any, inv) => {
        const id = inv.client_id
        if (!map[id]) map[id] = { name: inv.client?.name || '—', total: 0, unpaid: 0, count: 0, invoices: [], currency: inv.currency || 'INR' }
        map[id].total  += inv.total_amount || 0
        map[id].unpaid += Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0))
        map[id].count  += 1
        map[id].invoices.push(inv)
        return map
      }, {})
    ).sort((a: any, b: any) => b.unpaid - a.unpaid)

    // ── Overdue aging tab data ─────────────────────────────────────────────
    const overdueInvs = invoices.filter(i => isOverdue(i.due_date || '', i.status, i.issue_date) && i.status !== 'paid')
    const today       = new Date()
    function ageBucket(dueDate: string) {
      const days = Math.floor((today.getTime() - new Date(dueDate + 'T00:00:00').getTime()) / 86400000)
      if (days <= 30)  return { label: '1–30 days', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20' }
      if (days <= 60)  return { label: '31–60 days', color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/20' }
      if (days <= 90)  return { label: '61–90 days', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20' }
      return { label: '90+ days', color: 'text-red-600', bg: 'bg-red-600/15 border-red-600/30' }
    }
    const overdueFiltered = analyticsFilterClient
      ? overdueInvs.filter(i => i.client_id === analyticsFilterClient) : overdueInvs
    const totalOverdue  = overdueFiltered.reduce((s, i) => s + balanceDueInr(i), 0)
    const overdueByAge  = overdueFiltered.reduce((map: any, inv) => {
      const b = ageBucket(inv.due_date || '').label
      if (!map[b]) map[b] = { ...ageBucket(inv.due_date || ''), total: 0, count: 0 }
      map[b].total += Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0))
      map[b].count += 1; return map
    }, {})
    const overdueByClient = Object.values(
      overdueFiltered.reduce((map: any, inv) => {
        const id = inv.client_id
        if (!map[id]) map[id] = { name: inv.client?.name || '—', total: 0, oldest: inv.due_date || '', invoices: [] }
        map[id].total += Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0))
        if ((inv.due_date || '') < map[id].oldest) map[id].oldest = inv.due_date || ''
        map[id].invoices.push(inv); return map
      }, {})
    ).sort((a: any, b: any) => b.total - a.total)

    // ── Advance payments tab ───────────────────────────────────────────────
    const advFiltered    = analyticsFilterClient
      ? advancePayments.filter((p: any) => p.invoice?.client_id === analyticsFilterClient) : advancePayments
    const totalAdvance   = advFiltered.reduce((s: number, p: any) => s + (p.amount || 0), 0)

    // ── Job losses tab data ────────────────────────────────────────────────
    const lossFiltered   = analyticsFilterClient
      ? jobLosses.filter((j: any) => j.client?.id === analyticsFilterClient) : jobLosses
    const totalLoss      = lossFiltered.reduce((s: number, j: any) => s + (j.loss_amount || 0), 0)
    const lossClients    = Array.from(new Map(
      jobLosses.filter((j: any) => j.client).map((j: any) => [j.client.id, j.client])
    ).values())

    // ── Tab colors ─────────────────────────────────────────────────────────
    const TABS = [
      { id: 'discounts'  as const, label: 'Discounts',  color: 'text-orange-400', active: 'bg-orange-500/20 border-orange-500/40 text-orange-700 dark:text-orange-300', count: discAnalytics.length },
      { id: 'bad_debts'  as const, label: 'Bad Debts',  color: 'text-red-400',    active: 'bg-red-500/20 border-red-500/40 text-red-700 dark:text-red-300',          count: badDebtInvoices.length },
      { id: 'job_losses' as const, label: 'Job Losses', color: 'text-rose-400',   active: 'bg-rose-500/20 border-rose-500/40 text-rose-700 dark:text-rose-300',       count: jobLosses.length },
      { id: 'overdue'    as const, label: 'Overdue',    color: 'text-amber-400',  active: 'bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300',    count: overdueInvs.length },
      { id: 'advances'   as const, label: 'Advances',   color: 'text-blue-400',   active: 'bg-blue-500/20 border-blue-500/40 text-blue-700 dark:text-blue-300',       count: advancePayments.length },
      { id: 'expenses'   as const, label: 'Expenses',   color: 'text-amber-400',  active: 'bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300',    count: expenseReport.length },
    ]

    return (
      <div className="flex flex-col h-full bg-background overflow-hidden relative">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border/40 flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-semibold text-base flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-violet-400" />Financial Analytics
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">Discounts · Bad debts · Overdue aging · Advances</p>
          </div>
          <button onClick={() => setPanelMode('detail')} className="p-2 hover:bg-foreground/5 rounded-full text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-2 px-4 pt-3 pb-0 border-b border-border/40 bg-foreground/[0.01] overflow-x-auto hide-scrollbar shrink-0">
          {TABS.map(t => (
            <button key={t.id}
              onClick={() => {
                setAnalyticsTab(t.id)
                if (t.id === 'advances')  loadAdvancePayments()
                if (t.id === 'job_losses') loadJobLosses()
                if (t.id === 'expenses')  loadExpenseReport()
              }}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t-lg border border-b-0 transition-all shrink-0 ${analyticsTab === t.id ? t.active : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-foreground/5'}`}>
              {t.label}
              {t.count > 0 && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${analyticsTab === t.id ? 'bg-background/20 shadow-sm' : 'bg-foreground/[0.06]'}`}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">

          {/* ═══ DISCOUNTS TAB ════════════════════════════════════════════════ */}
          {analyticsTab === 'discounts' && (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-orange-400/70 mb-0.5">Total Given</div>
                  <div className="text-sm font-bold text-orange-700 dark:text-orange-300">{fmt(totalDiscGiven)}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Entries</div>
                  <div className="text-sm font-bold">{discRows.length}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Avg %</div>
                  <div className="text-sm font-bold">{avgDiscPct.toFixed(1)}%</div>
                </div>
              </div>

              {/* Filter */}
              <FilterDropdown
                options={discClients.map((c: any) => {
                  const cnt = discAnalytics.filter((d: any) => d.client?.id === c.id).length
                  const tot = discAnalytics.filter((d: any) => d.client?.id === c.id).reduce((s: number, d: any) => s + (d.discount_amount || 0), 0)
                  return { value: c.id, label: `${c.name} — ${cnt} · ${fmt(tot, c.default_currency || 'INR')}` }
                })}
                value={discFilterClient}
                onChange={setDiscFilterClient}
                placeholder={`All Clients (${discAnalytics.length} entries)`}
                sortKey="clients"
                className="w-full"
                maxLabelWidth="max-w-full"
              />

              {/* Per-client bars */}
              {!discFilterClient && discClients.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">By Client</div>
                  {discClients.map((c: any) => {
                    const cRows  = discAnalytics.filter((d: any) => d.client?.id === c.id)
                    const cTotal = cRows.reduce((s: number, d: any) => s + (d.discount_amount || 0), 0)
                    const cAvg   = cRows.length > 0 ? cRows.reduce((s: number, d: any) => s + (d.discount_percentage || 0), 0) / cRows.length : 0
                    const pct    = totalDiscGiven > 0 ? (cTotal / totalDiscGiven) * 100 : 0
                    return (
                      <div key={c.id} onClick={() => setDiscFilterClient(c.id)}
                        className="p-2.5 bg-foreground/[0.02] rounded-lg border border-border/30 hover:border-orange-500/30 cursor-pointer transition-colors">
                        <div className="flex items-center justify-between mb-1.5">
                          <div>
                            <div className="text-xs font-medium">{c.name}</div>
                            <div className="text-[10px] text-muted-foreground">{cRows.length} discount{cRows.length !== 1 ? 's' : ''} · avg {cAvg.toFixed(1)}%</div>
                          </div>
                          <div className="text-sm font-semibold text-orange-400">{fmt(cTotal, c.default_currency || 'INR')}</div>
                        </div>
                        <div className="h-1 bg-foreground/[0.06] rounded-full overflow-hidden">
                          <div className="h-full bg-orange-400/60 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Entries list */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                    {discFilterClient ? `${discRows.length} entries · ${fmt(totalDiscGiven, discRows[0]?.client?.default_currency || 'INR')} total` : 'All Entries'}
                  </div>
                  {discFilterClient && (
                    <button onClick={() => setDiscFilterClient('')} className="text-[10px] text-orange-400 hover:text-orange-700 dark:text-orange-300">Clear ×</button>
                  )}
                </div>
                {discAnalyticsLoading ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">Loading…</div>
                ) : discRows.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground bg-foreground/[0.02] rounded-xl border border-dashed border-border/40">No discounts recorded yet</div>
                ) : (
                  <div className="space-y-2">
                    {discRows.map((d: any, i: number) => (
                      <div key={d.id || i} className="p-3 bg-foreground/[0.02] rounded-xl border border-border/30 hover:border-orange-500/20 transition-colors">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="min-w-0">
                            <div className="text-xs font-medium">{d.client?.name || '—'}</div>
                            <div className="text-[10px] text-muted-foreground font-mono">{d.invoice?.invoice_number || '—'}</div>
                          </div>
                          <div className="flex items-start gap-2 shrink-0">
                            <div className="text-right">
                              <div className="text-sm font-bold text-orange-400">{fmt(d.discount_amount || 0, d.client?.default_currency || d.invoice?.currency || 'INR')}</div>
                              {(d.discount_percentage || 0) > 0 && (
                                <div className="text-[10px] text-muted-foreground">{(d.discount_percentage || 0).toFixed(1)}% off</div>
                              )}
                            </div>
                            <button
                              onClick={() => removeDiscountLog(d.id, d.invoice_id)}
                              title="Remove discount from invoice"
                              className="mt-0.5 p-1 text-red-400/50 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                        {d.reason && d.reason !== 'No reason provided' && (
                          <div className="text-[10px] text-muted-foreground italic bg-foreground/[0.02] px-2 py-1 rounded">{d.reason}</div>
                        )}
                        <div className="text-[10px] text-muted-foreground/50 mt-1">
                          {new Date(d.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ═══ BAD DEBTS TAB ════════════════════════════════════════════════ */}
          {analyticsTab === 'bad_debts' && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-red-400/70 mb-0.5">Total Written Off</div>
                  <div className="text-sm font-bold text-red-700 dark:text-red-300">{fmt(totalBadDebt)}</div>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-red-400/70 mb-0.5">Unrecovered</div>
                  <div className="text-sm font-bold text-red-700 dark:text-red-300">{fmt(badDebtUnpaid)}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Invoices</div>
                  <div className="text-sm font-bold">{badDebtInvoices.length}</div>
                </div>
              </div>

              {badDebtInvoices.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground bg-foreground/[0.02] rounded-xl border border-dashed border-border/40">
                  <BadgeCheck className="w-6 h-6 mx-auto mb-2 opacity-30" />
                  No bad debt invoices — great financial health!
                </div>
              ) : (
                <>
                  {/* By client */}
                  {bdByClient.length > 0 && (
                    <div>
                      <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">By Client</div>
                      <div className="space-y-1.5">
                        {(bdByClient as any[]).map((c: any, i) => (
                          <div key={i} className="p-2.5 bg-red-500/5 rounded-lg border border-red-500/20">
                            <div className="flex items-center justify-between mb-1">
                              <div>
                                <div className="text-xs font-medium">{c.name}</div>
                                <div className="text-[10px] text-muted-foreground">{c.count} invoice{c.count !== 1 ? 's' : ''}</div>
                              </div>
                              <div className="text-right">
                                <div className="text-sm font-bold text-red-400">{fmt(c.unpaid, c.currency)}</div>
                                {c.total !== c.unpaid && (
                                  <div className="text-[10px] text-muted-foreground">of {fmt(c.total, c.currency)} billed</div>
                                )}
                              </div>
                            </div>
                            {/* Invoice list for this client */}
                            <div className="space-y-1 mt-1.5">
                              {c.invoices.map((inv: Invoice) => (
                                <div key={inv.id} onClick={() => { selectInvoice(inv.id); setPanelMode('detail') }}
                                  className="flex items-center justify-between text-[10px] px-2 py-1 bg-red-500/5 rounded cursor-pointer hover:bg-red-500/10 transition-colors">
                                  <span className="font-mono text-muted-foreground">{inv.invoice_number}</span>
                                  <span className="text-muted-foreground">{fmtDate(inv.issue_date)}</span>
                                  <span className="text-red-400 font-semibold">
                                    {fmt(Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0)), inv.currency)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recovery rate */}
                  {totalBadDebt > 0 && (
                    <div className="bg-foreground/[0.03] rounded-xl border border-border/40 p-3">
                      <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Recovery Rate</div>
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="text-green-400">Recovered</span>
                        <span className="font-semibold text-green-400">{fmt(totalBadDebt - badDebtUnpaid)}</span>
                      </div>
                      <div className="h-2 bg-foreground/[0.06] rounded-full overflow-hidden">
                        <div className="h-full bg-green-500/60 rounded-full transition-all"
                          style={{ width: `${totalBadDebt > 0 ? ((totalBadDebt - badDebtUnpaid) / totalBadDebt) * 100 : 0}%` }} />
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-1">
                        {totalBadDebt > 0 ? (((totalBadDebt - badDebtUnpaid) / totalBadDebt) * 100).toFixed(1) : 0}% of bad debt recovered
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ═══ JOB LOSSES TAB ══════════════════════════════════════════════ */}
          {analyticsTab === 'job_losses' && (
            <>
              {/* Header row with refresh */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-rose-400">Cancelled Job Losses</span>
                <button
                  onClick={() => loadJobLosses(true)}
                  disabled={jobLossesLoading}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground bg-foreground/[0.04] hover:bg-foreground/[0.08] border border-border/40 rounded-lg transition-colors disabled:opacity-50">
                  <RefreshCw size={10} className={jobLossesLoading ? 'animate-spin' : ''} />
                  {jobLossesLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-rose-400/70 mb-0.5">Total Loss</div>
                  <div className="text-sm font-bold text-rose-700 dark:text-rose-300">{fmt(totalLoss)}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Jobs</div>
                  <div className="text-sm font-bold">{lossFiltered.length}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Clients</div>
                  <div className="text-sm font-bold">{new Set(lossFiltered.map((j: any) => j.client?.id)).size}</div>
                </div>
              </div>

              {/* By cancellation type */}
              {lossFiltered.length > 0 && (() => {
                const byType = lossFiltered.reduce((m: any, j: any) => {
                  const k = j.cancelled_by || 'unknown'
                  if (!m[k]) m[k] = { total: 0, count: 0 }
                  m[k].total += j.loss_amount || 0; m[k].count += 1; return m
                }, {})
                const typeLabels: any = { client: '👤 Client Cancellation', company: '🏢 Company Decision', no_show: '🚫 No-show', unknown: '❓ Unrecorded' }
                const typeColors: any = { client: 'text-amber-400', company: 'text-blue-400', no_show: 'text-red-400', unknown: 'text-muted-foreground' }
                return (
                  <div className="grid grid-cols-3 gap-1.5">
                    {Object.entries(byType).map(([type, data]: any) => (
                      <div key={type} className="bg-foreground/[0.02] border border-border/30 rounded-lg p-2 text-center">
                        <div className={`text-[10px] font-medium ${typeColors[type]}`}>{typeLabels[type]}</div>
                        <div className="text-xs font-bold mt-0.5">{fmt(data.total)}</div>
                        <div className="text-[9px] text-muted-foreground">{data.count} job{data.count !== 1 ? 's' : ''}</div>
                      </div>
                    ))}
                  </div>
                )
              })()}

              {/* Filter by client — always show when there are any losses */}
              {lossClients.length > 0 && (
                <FilterDropdown
                  options={lossClients.map((c: any) => {
                    const cJobs = jobLosses.filter((j: any) => j.client?.id === c.id)
                    const t = cJobs.reduce((s: number, j: any) => s + (j.loss_amount || 0), 0)
                    return { value: c.id, label: `${c.name} — ${cJobs.length} job${cJobs.length !== 1 ? 's' : ''} · ${fmt(t)}` }
                  })}
                  value={analyticsFilterClient}
                  onChange={setAnalyticsFilterClient}
                  placeholder={`All Clients (${jobLosses.length} jobs · ${fmt(jobLosses.reduce((s: number, j: any) => s + (j.loss_amount || 0), 0))})`}
                  sortKey="clients"
                  className="w-full"
                  maxLabelWidth="max-w-full"
                />
              )}

              {jobLossesLoading ? (
                <div className="py-8 text-center text-xs text-muted-foreground">Loading job losses…</div>
              ) : lossFiltered.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground bg-foreground/[0.02] rounded-xl border border-dashed border-border/40">
                  No job losses recorded yet.<br/>
                  <span className="text-[10px] opacity-60">Losses are recorded when you cancel a task and mark employee pay as honored.</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {lossFiltered.map((job: any, i: number) => {
                    const byLabel: any = { client: '👤 Client', company: '🏢 Company', no_show: '🚫 No-show' }
                    return (
                      <div key={job.id || i} className="p-3 bg-rose-500/5 rounded-xl border border-rose-500/20">
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-semibold">{job.title}</div>
                            <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                              <span>{job.client?.name || '—'}</span>
                              {job.service?.name && <span>· {job.service.name}</span>}
                              <span>· {fmtDate(job.task_date)}</span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-sm font-bold text-rose-400">{fmt(job.loss_amount || 0)}</div>
                            <div className="text-[10px] text-muted-foreground">of {fmt(job.billing_amount_inr || 0)} billed</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap text-[10px]">
                          {job.cancelled_by && (
                            <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                              {byLabel[job.cancelled_by] || job.cancelled_by}
                            </span>
                          )}
                          {(job.completion_pct || 0) > 0 && (
                            <span className="text-muted-foreground">{job.completion_pct}% completed</span>
                          )}
                          {job.honor_contributions && (
                            <span className="text-green-400">✓ Employees paid</span>
                          )}
                        </div>
                        {/* Completion bar */}
                        {(job.completion_pct || 0) > 0 && (
                          <div className="mt-2 h-1 bg-foreground/[0.06] rounded-full overflow-hidden">
                            <div className="h-full bg-rose-500/50 rounded-full" style={{ width: `${job.completion_pct}%` }} />
                          </div>
                        )}
                        {job.cancellation_notes && (
                          <div className="text-[10px] text-muted-foreground italic mt-1.5 bg-foreground/[0.02] px-2 py-1 rounded">
                            {job.cancellation_notes}
                          </div>
                        )}

                        {/* Employee earnings breakdown */}
                        {(job.contributions || []).length > 0 && (
                          <div className="mt-2">
                            <button
                              onClick={e => { e.preventDefault(); setExpandedLossId(expandedLossId === job.id ? null : job.id) }}
                              className="text-[10px] text-rose-400/70 hover:text-rose-400 flex items-center gap-1 transition-colors">
                              {expandedLossId === job.id ? '▲' : '▼'}
                              Employee Earnings ({(job.contributions || []).length} employee{(job.contributions || []).length !== 1 ? 's' : ''})
                              · {fmt((job.contributions || []).reduce((s: number, c: any) => s + (c.earnings_inr || 0), 0))} total
                            </button>
                            {expandedLossId === job.id && (
                              <div className="mt-1.5 space-y-1 border-t border-rose-500/15 pt-1.5">
                                {(job.contributions || []).map((c: any, ci: number) => (
                                  <div key={ci} className="flex items-center justify-between text-[10px] px-2 py-1 bg-foreground/[0.03] rounded">
                                    <span className="text-foreground font-medium">
                                      {dn(c.employee) || '—'}
                                    </span>
                                    <span className={job.honor_contributions ? 'text-green-400 font-semibold' : 'text-muted-foreground line-through'}>
                                      {fmt(c.earnings_inr || 0)}
                                      {job.honor_contributions ? ' ✓ paid' : ' ✗ not paid'}
                                    </span>
                                  </div>
                                ))}
                                <div className="flex items-center justify-between text-[10px] px-2 py-1 border-t border-rose-500/15 font-semibold">
                                  <span className="text-rose-400">Total employee cost</span>
                                  <span className="text-rose-400">
                                    {fmt((job.contributions || []).reduce((s: number, c: any) => s + (c.earnings_inr || 0), 0))}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        {(job.contributions || []).length === 0 && job.honor_contributions && (
                          <div className="text-[10px] text-muted-foreground mt-1.5 italic">
                            No contribution scores recorded for this task yet
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}

          {/* ═══ OVERDUE AGING TAB ════════════════════════════════════════════ */}
          {analyticsTab === 'overdue' && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-amber-400/70 mb-0.5">Total Overdue</div>
                  <div className="text-sm font-bold text-amber-700 dark:text-amber-300">{fmt(totalOverdue)}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Invoices</div>
                  <div className="text-sm font-bold">{overdueFiltered.length}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Clients</div>
                  <div className="text-sm font-bold">{overdueByClient.length}</div>
                </div>
              </div>

              {/* Client filter */}
              <FilterDropdown
                options={(overdueByClient as any[]).map((c: any) => ({
                  value: overdueInvs.find((inv: any) => inv.client?.name === c.name)?.client_id || '',
                  label: `${c.name} — ${fmt(c.total)}`,
                }))}
                value={analyticsFilterClient}
                onChange={setAnalyticsFilterClient}
                placeholder="All Clients"
                sortKey="clients"
                className="w-full"
                maxLabelWidth="max-w-full"
              />

              {overdueFiltered.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground bg-foreground/[0.02] rounded-xl border border-dashed border-border/40">
                  <CheckCircle className="w-6 h-6 mx-auto mb-2 opacity-30" />
                  No overdue invoices!
                </div>
              ) : (
                <>
                  {/* Age buckets */}
                  <div>
                    <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Aging Buckets</div>
                    <div className="space-y-1.5">
                      {['1–30 days', '31–60 days', '61–90 days', '90+ days'].map(label => {
                        const bucket = overdueByAge[label]
                        if (!bucket) return null
                        return (
                          <div key={label} className={`flex items-center justify-between p-2.5 rounded-lg border ${bucket.bg}`}>
                            <div>
                              <div className={`text-xs font-semibold ${bucket.color}`}>{label}</div>
                              <div className="text-[10px] text-muted-foreground">{bucket.count} invoice{bucket.count !== 1 ? 's' : ''}</div>
                            </div>
                            <div className={`text-sm font-bold ${bucket.color}`}>{fmt(bucket.total)}</div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* By client */}
                  <div>
                    <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">By Client (worst first)</div>
                    <div className="space-y-2">
                      {(overdueByClient as any[]).map((c: any, i) => {
                        const oldest = c.oldest ? Math.floor((today.getTime() - new Date(c.oldest + 'T00:00:00').getTime()) / 86400000) : 0
                        const bucket = c.oldest ? ageBucket(c.oldest) : null
                        return (
                          <div key={i} className="p-2.5 bg-foreground/[0.02] rounded-lg border border-border/30">
                            <div className="flex items-center justify-between mb-1.5">
                              <div>
                                <div className="text-xs font-medium">{c.name}</div>
                                <div className="text-[10px] text-muted-foreground">
                                  {c.invoices.length} invoice{c.invoices.length !== 1 ? 's' : ''}
                                  {oldest > 0 && <span className={` ml-1 ${bucket?.color}`}>· oldest {oldest}d overdue</span>}
                                </div>
                              </div>
                              <div className="text-sm font-bold text-amber-400">{fmt(c.total)}</div>
                            </div>
                            <div className="space-y-1">
                              {c.invoices.sort((a: Invoice, b: Invoice) => (a.due_date || '').localeCompare(b.due_date || '')).map((inv: Invoice) => {
                                const daysOver = inv.due_date
                                  ? Math.floor((today.getTime() - new Date(inv.due_date + 'T00:00:00').getTime()) / 86400000) : 0
                                const bkt = inv.due_date ? ageBucket(inv.due_date) : null
                                return (
                                  <div key={inv.id} onClick={() => { selectInvoice(inv.id); setPanelMode('detail') }}
                                    className="flex items-center justify-between text-[10px] px-2 py-1 bg-foreground/[0.02] rounded cursor-pointer hover:bg-amber-500/10 transition-colors">
                                    <span className="font-mono text-muted-foreground">{inv.invoice_number}</span>
                                    <span className={bkt?.color}>{daysOver}d overdue</span>
                                    <span className="text-amber-400 font-semibold">
                                      {fmt(Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0)), inv.currency)}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ═══ ADVANCES TAB ══════════════════════════════════════════════════ */}
          {analyticsTab === 'advances' && (
            <>
              {/* Client filter */}
              {advancePayments.length > 0 && (() => {
                const advClients = Array.from(new Map(
                  advancePayments.filter((p: any) => p.invoice?.client_id).map((p: any) => [p.invoice.client_id, p.invoice.client])
                ).values()) as any[]
                return advClients.length > 0 ? (
                  <FilterDropdown
                    options={advClients.map((c: any) => {
                      const cPmts = advancePayments.filter((p: any) => p.invoice?.client_id === c.id)
                      const t = cPmts.reduce((s: number, p: any) => s + (p.amount || 0), 0)
                      return { value: c.id, label: `${c.name} — ${cPmts.length} · ${fmt(t)}` }
                    })}
                    value={analyticsFilterClient}
                    onChange={setAnalyticsFilterClient}
                    placeholder="All Clients"
                    sortKey="clients"
                    className="w-full"
                    maxLabelWidth="max-w-full"
                  />
                ) : null
              })()}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-blue-400/70 mb-0.5">Total Advances</div>
                  <div className="text-sm font-bold text-blue-700 dark:text-blue-300">{fmt(totalAdvance)}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Payments</div>
                  <div className="text-sm font-bold">{advFiltered.length}</div>
                </div>
                <div className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Clients</div>
                  <div className="text-sm font-bold">{new Set(advFiltered.map((p: any) => p.invoice?.client_id)).size}</div>
                </div>
              </div>

              {advanceLoading ? (
                <div className="py-8 text-center text-xs text-muted-foreground">Loading advance payments…</div>
              ) : advFiltered.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground bg-foreground/[0.02] rounded-xl border border-dashed border-border/40">
                  No advance payments recorded yet
                </div>
              ) : (
                <div className="space-y-2">
                  {advFiltered.map((p: any, i: number) => (
                    <div key={p.id || i}
                      onClick={() => p.invoice_id && selectInvoice(p.invoice_id)}
                      className="p-3 bg-blue-500/5 rounded-xl border border-blue-500/20 hover:border-blue-500/40 cursor-pointer transition-colors">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <div className="min-w-0">
                          <div className="text-xs font-medium">{p.invoice?.client?.name || '—'}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">{p.invoice?.invoice_number || '—'}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-bold text-blue-400">{fmt(p.amount || 0)}</div>
                          <div className="text-[10px] text-muted-foreground">{METHOD_LABEL[p.payment_method] || p.payment_method}</div>
                        </div>
                      </div>
                      {p.reference && (
                        <div className="text-[10px] text-muted-foreground">Ref: {p.reference}</div>
                      )}
                      <div className="flex items-center justify-between mt-1">
                        <div className="text-[10px] text-blue-400/60">{fmtDate(p.payment_date)}</div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setReceiptPayment({ pmt: p, invoice: p.invoice }) }}
                          className="p-1 rounded bg-transparent text-blue-400 hover:text-blue-700 dark:text-blue-300 hover:bg-blue-500/20 transition-colors"
                          title="Generate Receipt"
                        >
                          <Receipt className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ═══ EXPENSES TAB ════════════════════════════════════════════════ */}
          {analyticsTab === 'expenses' && (
            <>
              {expenseReportLoading ? (
                <div className="text-center text-sm text-muted-foreground py-8">Loading…</div>
              ) : (() => {
                const totalOrig   = expenseReport.reduce((s: number, e: any) => s + (e.original_amount || e.amount || 0), 0)
                const totalMarkup = expenseReport.reduce((s: number, e: any) => s + (e.markup_amount || 0), 0)
                const totalBilled = expenseReport.reduce((s: number, e: any) => s + (e.amount || 0), 0)
                return (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-foreground/[0.04] border border-border/40 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-muted-foreground mb-0.5">Original Expenses</div>
                        <div className="text-sm font-bold">₹{totalOrig.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                      </div>
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-amber-400/70 mb-0.5">Markup Earned</div>
                        <div className="text-sm font-bold text-amber-700 dark:text-amber-300">+₹{totalMarkup.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                      </div>
                      <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-green-400/70 mb-0.5">Rebill Revenue</div>
                        <div className="text-sm font-bold text-green-700 dark:text-green-300">₹{totalBilled.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                      </div>
                    </div>
                    {expenseReport.length === 0 ? (
                      <div className="text-center text-xs text-muted-foreground py-6 border border-dashed border-border/40 rounded-xl">
                        No billed expenses yet
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {expenseReport.map((e: any) => {
                          const hasMarkup = e.markup_amount > 0
                          return (
                            <div key={e.id} className="flex items-start gap-3 p-2.5 bg-foreground/[0.02] border border-border/30 rounded-xl text-xs">
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate">{e.description}</div>
                                <div className="text-[10px] text-muted-foreground mt-0.5">
                                  {e.invoice?.client?.name} · {e.invoice?.invoice_number}
                                </div>
                                {e.notes && <div className="text-[10px] text-muted-foreground/60 italic mt-0.5">{e.notes}</div>}
                              </div>
                              <div className="text-right shrink-0">
                                <div className="font-mono font-semibold text-amber-700 dark:text-amber-300">
                                  {fmt(e.amount, e.currency)}
                                </div>
                                {hasMarkup && (
                                  <div className="text-[10px] text-muted-foreground">
                                    Cost {fmt(e.original_amount, e.currency)} + {fmt(e.markup_amount, e.currency)}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )
              })()}
            </>
          )}

        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN RENDER
  // ─────────────────────────────────────────────────────────────────────────
  const showRightPanel = selectedInv || ['new', 'generate', 'batch_generate', 'discounts'].includes(panelMode)

  return (
    <div className="flex flex-col h-dvh bg-background text-foreground">
      <Header title="Invoices" />
      <ToastContainer toasts={toasts} onDismiss={dismiss} />

      {leaveGuard && (
        <ConfirmDialog
          title="Leave without creating this invoice?"
          body="The lines, client and notes you entered are discarded. Nothing has been invoiced yet, so the work stays available to invoice later."
          confirmLabel="Discard and leave"
          danger
          onConfirm={() => { const g = leaveGuard; setLeaveGuard(null); g.proceed() }}
          onCancel={() => setLeaveGuard(null)}
        />
      )}

      {/* ── Confirmation modal ── */}
      {confirmModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setConfirmModal(null) }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-secondary border border-foreground/15 rounded-2xl shadow-2xl w-full max-w-sm p-5 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="font-semibold text-sm mb-2">{confirmModal.title}</h3>
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed">{confirmModal.body}</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-foreground/15 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors">
                Cancel
              </button>
              <button onClick={confirmModal.onConfirm}
                className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                  confirmModal.danger
                    ? 'bg-red-600 hover:bg-red-500 text-white'
                    : 'bg-violet-600 hover:bg-violet-500 text-white'
                }`}>
                {confirmModal.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Stats bar (collapsible) ──
          When collapsed: a single compact summary row showing the key counts.
          When expanded: the full 2/6-col grid of stat tiles + action tiles. */}
      {statsCollapsed ? (
        <button
          onClick={toggleStats}
          className={cn("w-full border-b border-border/40 px-4 py-2.5 flex items-center justify-between text-left", ROW_INTERACTIVE_CLASS)}
        >
          <div className="flex items-center gap-2.5 text-xs flex-wrap min-w-0">
            {/* Portfolio position — every figure here sums across clients, so
                the whole strip follows billing.view_totals rather than the
                per-invoice `amounts` grant. */}
            {showTotals && (
              <span className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Outstanding</span>
                <span className="font-bold text-foreground">{fmt(stats.outstanding)}</span>
              </span>
            )}
            {showTotals && stats.overdueCount > 0 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="font-semibold text-red-400">{stats.overdueCount} overdue</span>
              </>
            )}
            {showTotals && stats.draftCount > 0 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="font-semibold text-amber-400 flex items-center gap-1">
                  <Zap className="w-2.5 h-2.5" />{stats.draftCount} drafts
                </span>
              </>
            )}
          </div>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground shrink-0 ml-2">
            <span className="hidden sm:inline">Show actions</span>
            <ChevronDown className="w-3.5 h-3.5" />
          </span>
        </button>
      ) : (
        <div className="border-b border-border/40">
          <div className="flex items-center justify-end px-4 pt-1.5">
            <button
              onClick={toggleStats}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <span className="hidden sm:inline">Hide</span>
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="px-4 pt-1 pb-2.5 grid grid-cols-2 sm:grid-cols-6 gap-3">
            {/* Same rule as the collapsed strip: these tiles sum across every
                client, so they follow billing.view_totals. Without it the panel
                still opens — it just carries the action buttons and not the
                portfolio position. */}
            {showTotals && (
            <div className="bg-foreground/[0.03] rounded-xl p-3 border border-border/30">
              <div className="text-[10px] text-muted-foreground mb-0.5">Outstanding</div>
              <div className="text-sm font-bold text-foreground">{fmt(stats.outstanding)}</div>
            </div>
            )}
            {showTotals && (
            <div className={`bg-foreground/[0.03] rounded-xl p-3 border ${stats.overdueCount > 0 ? 'border-red-500/30' : 'border-border/30'}`}>
              <div className="text-[10px] text-muted-foreground mb-0.5">Overdue</div>
              <div className={`text-sm font-bold flex flex-wrap items-baseline gap-1 ${stats.overdueCount > 0 ? 'text-red-400' : 'text-foreground'}`}>
                <span>{fmt(stats.overdueAmt)}</span>
                {stats.overdueCount > 0 && <span className="text-[10px]">({stats.overdueCount})</span>}
              </div>
            </div>
            )}
            <div className={`bg-foreground/[0.03] rounded-xl p-3 border ${stats.draftCount > 0 ? 'border-amber-500/30' : 'border-border/30'}`}>
              <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-1">
                <Zap className="w-2.5 h-2.5" />Auto Drafts
              </div>
              {/* The count is workload and stays; the value is portfolio money. */}
              <div className={`text-sm font-bold ${stats.draftCount > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                {stats.draftCount > 0
                  ? (showTotals ? `${stats.draftCount} · ${fmt(stats.draftTotal)}` : String(stats.draftCount))
                  : '—'}
              </div>
            </div>
            <button
              onClick={() => { setPanelMode('generate'); setSelectedId(null); setGenTasks([]) }}
              className={`rounded-xl p-3 border flex items-center gap-2 text-left transition-colors ${panelMode === 'generate' ? 'bg-amber-500/20 border-amber-500/40' : 'bg-amber-50 dark:bg-amber-600/10 hover:bg-amber-100 dark:hover:bg-amber-600/20 border-amber-200 dark:border-amber-500/20'}`}>
              <Calendar className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
              <div>
                <div className="text-[10px] text-amber-600/70 dark:text-amber-700 dark:text-amber-300/70">Add-on</div>
                <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">Generate</div>
              </div>
            </button>
            <button
              onClick={() => { setPanelMode('batch_generate'); setSelectedId(null); setBatchGroups([]); setBatchDone(0) }}
              className={`rounded-xl p-3 border flex items-center gap-2 text-left transition-colors ${panelMode === 'batch_generate' ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-emerald-50 dark:bg-emerald-600/10 hover:bg-emerald-100 dark:hover:bg-emerald-600/20 border-emerald-200 dark:border-emerald-500/20'}`}>
              <History className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div>
                <div className="text-[10px] text-emerald-700/70 dark:text-emerald-700 dark:text-emerald-300/70">Batch</div>
                <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Historical</div>
              </div>
            </button>
            <button
              // Statements moved to their own page (/dashboard/statements): a
              // running ledger with opening/closing balance and ageing needs the
              // client's FULL history, which this page no longer loads.
              onClick={() => router.push('/dashboard/statements')}
              className="rounded-xl p-3 border flex items-center gap-2 text-left transition-colors bg-blue-50 dark:bg-blue-600/10 hover:bg-blue-100 dark:hover:bg-blue-600/20 border-blue-200 dark:border-blue-500/20">
              <Receipt className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <div>
                <div className="text-[10px] text-blue-700/70 dark:text-blue-700 dark:text-blue-300/70">Account</div>
                <div className="text-xs font-semibold text-blue-700 dark:text-blue-300">Statement</div>
              </div>
            </button>
            <button
              onClick={() => { setPanelMode('discounts'); setSelectedId(null); loadDiscountAnalytics() }}
              className={`rounded-xl p-3 border flex items-center gap-2 text-left transition-colors ${panelMode === 'discounts' ? 'bg-violet-500/20 border-violet-500/40' : 'bg-violet-50 dark:bg-violet-600/10 hover:bg-violet-100 dark:hover:bg-violet-600/20 border-violet-200 dark:border-violet-500/20'}`}>
              <TrendingUp className="w-4 h-4 text-violet-600 dark:text-violet-400 shrink-0" />
              <div>
                <div className="text-[10px] text-violet-700/70 dark:text-violet-700 dark:text-violet-300/70">Financial</div>
                <div className="text-xs font-semibold text-violet-700 dark:text-violet-300">Analytics</div>
              </div>
            </button>
          </div>

          {/* ── Stage-wise value cards (click-to-filter) ── */}
          <div className="px-4 pb-2.5 grid grid-cols-2 sm:grid-cols-5 gap-2">
            {([
              { key: 'draft',    label: 'Draft',    active: 'bg-amber-500/15 border-amber-500/40',   dot: 'bg-amber-400' },
              { key: 'reviewed', label: 'Reviewed', active: 'bg-blue-500/15 border-blue-500/40',     dot: 'bg-blue-400' },
              { key: 'sent',     label: 'Sent',     active: 'bg-violet-500/15 border-violet-500/40', dot: 'bg-violet-400' },
              { key: 'partial',  label: 'Partial',  active: 'bg-cyan-500/15 border-cyan-500/40',     dot: 'bg-cyan-400' },
              { key: 'overdue',  label: 'Overdue',  active: 'bg-red-500/15 border-red-500/40',       dot: 'bg-red-400' },
            ] as const).map(st => {
              const s = stats.stages[st.key]
              const isActive = filterStatus === st.key
              return (
                <button
                  key={st.key}
                  onClick={() => setFilterStatus(isActive ? '' : st.key)}
                  title={isActive ? 'Clear filter' : `Show ${st.label.toLowerCase()} invoices`}
                  className={cn(
                    'rounded-xl px-3 py-2 border text-left transition-colors',
                    isActive ? st.active : 'bg-foreground/[0.03] border-border/30 hover:border-foreground/25'
                  )}
                >
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-0.5">
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', s.count > 0 ? st.dot : 'bg-border')} />
                    {st.label}
                    <span className="ml-auto font-semibold text-foreground/70">{s.count}</span>
                  </div>
                  {/* The count is how the work is triaged — nine drafts to send
                      is the job. The value of those nine is a portfolio figure
                      and follows showTotals. */}
                  {showTotals && (
                    <div className={cn('text-xs font-bold', s.count > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                      {s.count > 0 ? fmt(s.amount) : '—'}
                    </div>
                  )}
                </button>
              )
            })}
          </div>

          {/* ── Month-wise outstanding dues ── */}
          {showTotals && stats.monthDues.length > 0 && (
            <div className="px-4 pb-3 flex items-center gap-1.5 overflow-x-auto hide-scrollbar [&>*]:shrink-0">
              <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mr-0.5">Dues by month</span>
              {stats.monthDues.map(m => (
                <span
                  key={m.key}
                  title={`${m.count} invoice${m.count !== 1 ? 's' : ''} due in ${m.label}`}
                  className="inline-flex items-baseline gap-1.5 rounded-lg border border-border/40 bg-foreground/[0.03] px-2 py-1"
                >
                  <span className="text-[10px] font-medium text-muted-foreground">{m.label}</span>
                  <span className="text-[11px] font-bold text-foreground">{fmt(m.amount)}</span>
                  <span className="text-[9px] text-muted-foreground">({m.count})</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex items-center gap-0 border-b border-border/40 px-4 pt-1">
        {(['active', 'closed', 'all'] as const).map(t => (
          <button key={t}
            onClick={() => { setTab(t); setFilterStatus('') }}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${tab === t ? 'border-violet-500 text-violet-700 dark:text-violet-300' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t === 'active' ? `Active (${invoices.filter(i => STATUS_GROUPS.active.includes(i.status) || (isOverdue(i.due_date || '', i.status, i.issue_date) && i.status !== 'paid')).length})` : t === 'closed' ? `Closed` : `All`}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => {
            const rows = [
              ['Invoice #', 'Client', 'Status', 'Issue Date', 'Due Date', 'Currency', 'Subtotal', 'Discount', 'Tax', 'Total', 'Paid', 'Balance'],
              ...invoices.map(inv => [
                inv.invoice_number,
                inv.client?.name || '',
                inv.status,
                inv.issue_date || '',
                inv.due_date || '',
                inv.currency,
                (inv.subtotal || inv.total_amount || 0).toFixed(2),
                (inv.discount_amount || 0).toFixed(2),
                (inv.tax_amount || 0).toFixed(2),
                (inv.total_amount || 0).toFixed(2),
                (inv.paid_amount || 0).toFixed(2),
                balanceDue(inv).toFixed(2),
              ])
            ]
            const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
            const blob = new Blob([csv], { type: 'text/csv' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a'); a.href = url
            a.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`
            a.click(); URL.revokeObjectURL(url)
          }}
          className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground border border-border/40 hover:border-border/70 rounded-lg px-2.5 py-1 transition-colors bg-foreground/[0.02] hover:bg-foreground/[0.05]">
          <Download className="w-3.5 h-3.5" />Export CSV
        </button>
        <button
          onClick={() => { setPanelMode('new'); setSelectedId(null) }}
          className="mb-1 flex items-center gap-1 text-[11px] font-medium text-violet-400 hover:text-violet-700 dark:text-violet-300 border border-violet-500/30 hover:border-violet-500/60 rounded-lg px-2.5 py-1 transition-colors bg-violet-500/5 hover:bg-violet-500/10">
          <Plus className="w-3.5 h-3.5" />New Invoice
        </button>
      </div>

      {/* ── Main content ── */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left: list */}
        <div className={`${showRightPanel ? 'hidden sm:flex sm:w-[320px] lg:w-[360px]' : 'flex-1'} flex-col border-r border-border/40 overflow-hidden`}>
          {renderList()}
        </div>

        {/* Right: detail / payment / new */}
        {showRightPanel ? (
          <div className="flex-1 overflow-hidden flex flex-col">
            {/* Mobile back button */}
            <div className="sm:hidden px-3 py-2 border-b border-border/40">
              <button onClick={() => { setSelectedId(null); setPanelMode('detail') }}
                className="text-xs text-violet-400 flex items-center gap-1">
                ← Back to invoices
              </button>
            </div>
            {panelMode === 'new'            && renderNewPanel()}
            {panelMode === 'generate'       && renderGeneratePanel()}
            {panelMode === 'batch_generate' && renderBatchGeneratePanel()}
            {panelMode === 'discounts'      && renderDiscountsPanel()}
            {panelMode === 'detail'    && selectedInv && renderDetail(selectedInv)}
            {panelMode === 'pay'       && selectedInv && renderPayPanel(selectedInv)}
          </div>
        ) : (
          /* Empty state when no selection on desktop */
          <div className="hidden sm:flex flex-1 items-center justify-center text-muted-foreground">
            <div className="text-center">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">Select an invoice to view details</p>
              <p className="text-xs mt-1 opacity-60">Tasks marked &quot;done&quot; auto-generate draft invoices</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Edit Reason Modal ─────────────────────────────────────────────────── */}
      {/* ── Invoice Preview Modal ───────────────────────────────────────────── */}
      {previewInv && (() => {
        // An invoice whose line items have not arrived still has a client, a
        // number and a TOTAL — so it renders as a complete-looking document
        // with an empty table. That is the one output here that can do real
        // damage: printed or sent, it bills a client an amount with nothing
        // itemised behind it. Print and Download stay disabled, and the paper
        // is not drawn at all, until the lines are actually in hand.
        const previewReady = detailLoaded.has(previewInv.id)
        const previewFailed = detailFailed.has(previewInv.id)
        return (
        <ModalOverlay onClose={() => setPreviewInv(null)} zIndex="z-[300]">
          <div className="flex flex-col bg-secondary border border-foreground/15 rounded-2xl shadow-2xl overflow-hidden"
            style={{ width: 'min(860px, 96vw)', height: 'min(92vh, 900px)' }}>
            {/* Modal header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-foreground/15 shrink-0">
              <div className="flex items-center gap-2.5">
                <Eye className="w-4 h-4 text-violet-400" />
                <div>
                  <h3 className="font-semibold text-sm">{previewInv.invoice_number}</h3>
                  <p className="text-[11px] text-muted-foreground">{previewInv.client?.name}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label
                  title="Add the client's other overdue/pending invoices as an extra line on this PDF — not saved to the invoice, for sharing only"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-foreground/[0.06] text-xs font-medium text-foreground cursor-pointer border border-foreground/15">
                  {loadingOutstandingId === previewInv.id
                    ? <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                    : <input type="checkbox" checked={includeOutstanding.has(previewInv.id)}
                        onChange={() => toggleIncludeOutstanding(previewInv)}
                        className="rounded accent-violet-500 cursor-pointer" />}
                  Include Outstanding
                </label>
                <button onClick={() => printInvoice(previewInv)} disabled={!previewReady || !canSharePdf}
                  title={!canSharePdf ? noShareReason : previewReady ? undefined : 'Line items are still loading'}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15 disabled:opacity-50 disabled:cursor-not-allowed">
                  <Printer className="w-3.5 h-3.5" />Print
                </button>
                <button onClick={() => downloadInvoicePdf(previewInv)} disabled={!previewReady || !canSharePdf || downloadingInvId === previewInv.id}
                  title={!canSharePdf ? noShareReason : previewReady ? undefined : 'Line items are still loading'}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15 disabled:opacity-50">
                  {downloadingInvId === previewInv.id
                    ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    : <Download className="w-3.5 h-3.5" />}Download
                </button>
                <button onClick={() => setPreviewInv(null)}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded-lg transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* Invoice rendered in iframe — scrollable on mobile */}
            {!canSharePdf && (
              <div className="shrink-0 px-4 py-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
                {noShareReason}
              </div>
            )}
            <div className="flex-1 overflow-auto bg-[#f5f7fa] rounded-b-2xl" style={{ WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
              <div style={{ minWidth: 680, height: '100%' }}>
                {previewReady ? (
                  <iframe
                    // key forces a full remount on toggle — changing srcDoc on an
                    // already-mounted iframe doesn't reliably reload its content.
                    key={`${previewInv.id}-${includeOutstanding.has(previewInv.id)}`}
                    srcDoc={buildInvoiceHtml(previewInv)}
                    className="w-full h-full border-0"
                    style={{ minHeight: 600 }}
                    title="Invoice Preview"
                    sandbox="allow-same-origin"
                  />
                ) : (
                  <div className="flex h-full min-h-[600px] flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[#5b6472]">
                    {previewFailed ? (
                      <>
                        <span className="max-w-sm">
                          The line items for this invoice couldn&apos;t be loaded, so the
                          document would show a total with nothing itemised. It isn&apos;t
                          safe to print or send in that state.
                        </span>
                        <button
                          onClick={() => {
                            setDetailFailed(prev => { const n = new Set(prev); n.delete(previewInv.id); return n })
                            void ensureDetails([previewInv.id])
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-[#c9d2de] bg-white px-3 py-1.5 text-xs font-medium text-[#1f2a37] transition-colors hover:bg-[#eef2f7]"
                        >
                          <RefreshCw className="h-3 w-3" />Try again
                        </button>
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-5 w-5 animate-spin" />
                        <span>Loading line items…</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </ModalOverlay>
        )
      })()}

      {editReasonModal && (
        <ModalOverlay onClose={() => { setEditReasonModal(null); setEditReasonInput('') }}>
          <div className="bg-card border border-border/60 rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center shrink-0">
                <Edit2 className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Force Edit Invoice</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  This invoice is locked. Provide a reason to enable editing. All changes will be logged.
                </p>
              </div>
            </div>

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 mb-4 text-xs text-amber-700 dark:text-amber-300">
              ⚠️ Editing a sent/paid invoice overrides system-generated data. Ensure this change is intentional.
            </div>

            <div className="mb-4">
              <label className="text-xs text-muted-foreground mb-1.5 block">Reason for editing *</label>
              <textarea
                autoFocus
                value={editReasonInput}
                onChange={e => setEditReasonInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmEditUnlock() }}
                placeholder="e.g. Client requested correction on service description, price adjustment per agreement…"
                rows={3}
                className="w-full bg-background border border-border/40 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-amber-500/50 resize-none placeholder:text-muted-foreground/40"
              />
              <div className="text-[10px] text-muted-foreground mt-1">Ctrl+Enter to confirm</div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { setEditReasonModal(null); setEditReasonInput('') }}
                className="flex-1 py-2 border border-border/40 text-sm text-muted-foreground rounded-xl hover:bg-foreground/5 transition-colors">
                Cancel
              </button>
              <button
                onClick={confirmEditUnlock}
                disabled={!editReasonInput.trim()}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors">
                <Edit2 className="w-3.5 h-3.5" />Unlock & Edit
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {editClientId && (
        <ClientEditModal clientId={editClientId} onClose={() => setEditClientId(null)} />
      )}

      {allocatingInvoice && (
        <AllocateFromCashbookModal
          invoiceId={allocatingInvoice.id}
          invoiceNumber={allocatingInvoice.invoice_number}
          clientId={allocatingInvoice.client_id}
          clientName={allocatingInvoice.client?.name}
          balanceDueInr={balanceDueInr(allocatingInvoice)}
          invoiceCurrency={allocatingInvoice.currency}
          exchangeRate={allocatingInvoice.exchange_rate}
          balanceDueNative={balanceDue(allocatingInvoice)}
          marketRate={rateMap[allocatingInvoice.currency]}
          unsettled={invPaidInr(allocatingInvoice) === 0}
          onClose={() => setAllocatingInvoice(null)}
          onUpdate={() => { setAllocatingInvoice(null); router.refresh() }}
        />
      )}

      {approvalInvoice && (
        <RequestApprovalDialog
          defaults={{ entityType: 'invoice', entityId: approvalInvoice.id, title: `Approve invoice ${approvalInvoice.invoice_number}` }}
          onClose={() => setApprovalInvoice(null)}
          onCreated={() => setApprovalInvoice(null)}
        />
      )}

      {addExpenseInvoice && (
        <AddExpenseModal
          invoiceId={addExpenseInvoice.id}
          invoiceNumber={addExpenseInvoice.invoice_number}
          clientId={addExpenseInvoice.client_id}
          clientName={addExpenseInvoice.client?.name}
          invoiceCurrency={addExpenseInvoice.currency}
          exchangeRate={addExpenseInvoice.exchange_rate || 1}
          existingExpenses={addExpenseInvoice.expense_items || []}
          canMarkup={role === 'super_admin' || role === 'accounts'}
          onClose={() => setAddExpenseInvoice(null)}
          onUpdate={() => { setAddExpenseInvoice(null); router.refresh() }}
        />
      )}

      {receiptPayment && (
        <ReceiptModal
          input={((): ReceiptInput => {
            const inv = receiptPayment.invoice
            const pmt = receiptPayment.pmt
            const compact = (pmt.payment_date || '').replace(/-/g, '')
            const legacyNo = `RCPT-${compact}-${pmt.id.slice(-4).toUpperCase()}`
            // `payments` doesn't store its own receipt number / bank account — pull
            // them from the auto-created cashbook entry (real just-recorded payment
            // carries these directly; a payment loaded from the server is matched
            // via findLinkedCashbookEntry).
            const linkedEntry = inv ? findLinkedCashbookEntry(inv, pmt) : undefined

            return {
              receiptNo: pmt.receipt_number || linkedEntry?.receipt_number || legacyNo,
              defaultClientName: inv?.client?.name || '',
              amount: pmt.amount ?? pmt.amount_inr ?? 0,
              currency: pmt.currency,
              dateISO: pmt.payment_date,
              method: pmt.bank_account_name || linkedEntry?.bank_account?.name || pmt.payment_method?.replace(/_/g, ' '),
              reference: pmt.reference,
              invoices: [{
                number: inv?.invoice_number || '—',
                outstanding: inv ? Number(inv.total_amount) - Number(inv.paid_amount || 0) : 0,
              }],
              companyLogoUrl: resolveBrandingUrl(companySettings.logo_url_dark || companySettings.logo_url),
              companyName:    companySettings.company_name,
              companyPhone:   companySettings.company_phone,
              companyWebsite: companySettings.company_website,
            }
          })()}
          onClose={() => setReceiptPayment(null)}
        />
      )}
    </div>
  )
}
