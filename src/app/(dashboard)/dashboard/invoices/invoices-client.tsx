'use client'

import QRCode from 'qrcode'
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { usePrivacy } from '@/contexts/privacy-context'
import { useCopy } from '@/lib/hooks/use-copy'
import Header from '@/components/layout/header'
import { ActiveFilterChips } from '@/components/ui/active-filter-chips'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import {
  generateInvoiceNumber,
  getInvoiceDateForTaskMonth,
  buildBillingPeriod,
  toSequenceMonth,
} from '@/lib/invoices/numbering'
import { createClient } from '@/lib/supabase/client'
import {
  getStatusColor, getStatusLabel, isOverdue,
  isEditable, formatBillingPeriod, getNextAction,
} from '@/lib/utils/invoice'
import { formatCurrency, getCurrencySymbol, round2 } from '@/lib/calculations/currency'
import CurrencyAmountInput, { type RateSource } from '@/components/ui/currency-amount-input'
import {
  FileText, Plus, X, ChevronRight, CheckCircle, Send, CreditCard,
  Trash2, AlertTriangle, Clock, Eye, Lock, Zap, Download, RefreshCw,
  Calendar, Building2, IndianRupee, MoreHorizontal, Search, Filter,
  Printer, TrendingUp, BadgeCheck, CircleDollarSign, Receipt, Edit2, Save,
  History, Tag, Percent, ChevronDown, ChevronUp, ArrowDownToLine, Gift, ExternalLink, Copy,
  Wallet, Link2, ShoppingBag, Share2,
} from 'lucide-react'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { useRole } from '@/contexts/role-context'
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
  cashbook_invoice_allocations?: {
    id: string
    deleted_at?: string | null
    allocated_amount?: number
    cashbook_entry?: { id: string; reference?: string | null; entry_date?: string; description?: string | null } | null
  }[]
}

interface Props {
  initialInvoices: Invoice[]
  clients: { id: string; name: string; code: string; phone?: string; email?: string; address?: string; default_currency?: string }[]
  bankAccounts: { id: string; name: string }[]
  services: { id: string; name: string }[]
  companySettings: Record<string, string>
  exchangeRates: { currency: string; rate_to_inr: number; rate_date?: string }[]
  /**
   * Per-field financial visibility resolved server-side from the user's
   * permission set. When `amounts` is false, total_amount/paid_amount and
   * payment.amount have already been stripped from `initialInvoices`; the
   * client uses this flag to suppress the corresponding UI cells/columns.
   */
  visibility: {
    amounts:     boolean
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
function invTotalInr(inv: Invoice): number { return inv.total_amount_inr ?? inv.total_amount ?? 0 }
function invPaidInr(inv: Invoice): number { return inv.paid_amount_inr ?? inv.paid_amount ?? 0 }
function balanceDueInr(inv: Invoice): number { return Math.max(0, invTotalInr(inv) - invPaidInr(inv)) }
// True when this invoice is paid through the cashbook-allocation path. Such an
// invoice must not also take a direct "Record Payment" (the two would clobber).
function hasActiveAllocations(inv: Invoice): boolean {
  return (inv.cashbook_invoice_allocations || []).some(a => !a.deleted_at)
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function InvoicesClient({ initialInvoices, clients, bankAccounts, services, companySettings, exchangeRates, visibility }: Props) {
  const showAmounts     = visibility.amounts
  const showLinePricing = visibility.linePricing
  const supabase = createClient()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const { role } = useRole()
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [filterStatus, setFilterStatus] = useState<string>(searchParams.get('status') || '')
  const [filterClient, setFilterClient] = useState<string>(searchParams.get('client') || '')
  const [searchFacets, setSearchFacets] = useState<SearchFacet[]>(() => {
    try { const raw = searchParams.get('sf'); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [searchDraft, setSearchDraft] = useState('')
  const activeFacets = useMemo<SearchFacet[]>(
    () => searchDraft.trim() ? [...searchFacets, { field: 'any', op: 'contains' as const, text: searchDraft.trim() }] : searchFacets,
    [searchFacets, searchDraft],
  )
  const [tab, setTab] = useState<'active' | 'closed'>((searchParams.get('tab') as any) || 'active')

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())

    if (filterStatus) params.set('status', filterStatus); else params.delete('status')
    if (filterClient) params.set('client', filterClient); else params.delete('client')
    if (searchFacets.length) params.set('sf', JSON.stringify(searchFacets)); else params.delete('sf')
    if (tab && tab !== 'active') params.set('tab', tab); else params.delete('tab')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [filterStatus, filterClient, searchFacets, tab, pathname, router, searchParams])
  const [editClientId, setEditClientId] = useState<string | null>(null)

  // Panel modes
  const [panelMode, setPanelMode] = useState<'detail' | 'pay' | 'new' | 'generate' | 'batch_generate' | 'statement' | 'discounts'>('detail')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Bulk actions
  const [selectedForBulk, setSelectedForBulk] = useState<Set<string>>(new Set())
  const [isUpdatingBulk, setIsUpdatingBulk] = useState(false)

  // Confirmation modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void
  } | null>(null)

  // "Allocate From Cash Book" — the invoice this modal is open for, if any.
  const [allocatingInvoice, setAllocatingInvoice] = useState<Invoice | null>(null)

  // "Add Client Expenses" — the invoice this modal is open for, if any.
  const [addExpenseInvoice, setAddExpenseInvoice] = useState<Invoice | null>(null)

  // Payment form. `amount` is in the payment `currency`; `amountInr` is the
  // INR base; `rate` is rate_to_inr. Defaults to the invoice currency when the
  // pay panel opens (see openPayPanel).
  const [payForm, setPayForm] = useState({
    amount: '', currency: 'INR' as Currency, rate: '', amountInr: '', rateSource: 'settings' as RateSource,
    payment_date: new Date().toISOString().split('T')[0],
    payment_method: 'bank_transfer', reference: '', notes: '', bank_account_id: '',
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
    issue_date: new Date().toISOString().split('T')[0],
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
    return window.innerWidth < 640 // default: collapsed on mobile, expanded on sm+
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
    date_from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    date_to: new Date().toISOString().split('T')[0],
    specific_date: new Date().toISOString().split('T')[0],
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

  // Statement generator
  const [stmtDetailed, setStmtDetailed] = useState(false)
  const [stmtExpandedIds, setStmtExpandedIds] = useState<Set<string>>(new Set())
  const [stmtForm, setStmtForm] = useState({
    client_id: '',
    mode: 'month' as 'month' | 'year' | 'range' | 'day',
    month: new Date().toISOString().slice(0, 7),
    year: String(new Date().getFullYear()),
    date_from: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    date_to: new Date().toISOString().split('T')[0],
    specific_date: new Date().toISOString().split('T')[0],
  })

  // ── Navigation guard: warn before leaving while new invoice form is open ──
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
      if (window.confirm('You have unsaved changes on the new invoice. Leave and discard?')) {
        proceed()
      }
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
    let list = invoices.filter(inv => {
      const inTab = tab === 'active'
        ? STATUS_GROUPS.active.includes(inv.status) || (isOverdue(inv.due_date || '', inv.status) && inv.status !== 'paid')
        : STATUS_GROUPS.closed.includes(inv.status)
      if (!inTab) return false
      if (filterStatus && inv.status !== filterStatus) return false
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

  // Summary stats
  const stats = useMemo(() => {
    const active = invoices.filter(i => !['paid', 'cancelled', 'bad_debt'].includes(i.status))
    const drafts = invoices.filter(i => i.status === 'draft')
    const overdue = invoices.filter(i => isOverdue(i.due_date || '', i.status))
    return {
      // Company-wide KPI cards are shown in ₹ — sum the INR snapshots, not the
      // raw invoice-currency amounts (which would mix SAR/USD/INR together).
      outstanding: active.reduce((s, i) => s + balanceDueInr(i), 0),
      overdueAmt: overdue.reduce((s, i) => s + balanceDueInr(i), 0),
      draftCount: drafts.length,
      draftTotal: drafts.reduce((s, i) => s + invTotalInr(i), 0),
      overdueCount: overdue.length,
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

  async function updateStatus(invoiceId: string, newStatus: string) {
    setSaving(true)
    const updates: any = { status: newStatus, updated_at: new Date().toISOString() }
    // Auto-set due date when sending (30 days from today)
    if (newStatus === 'sent' && !invoices.find(i => i.id === invoiceId)?.due_date) {
      const dd = new Date(); dd.setDate(dd.getDate() + 30)
      updates.due_date = dd.toISOString().split('T')[0]
    }
    const { error } = await supabase.from('invoices').update(updates).eq('id', invoiceId)
    if (error) { toastError(error.message); setSaving(false); return }

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
    setSaving(false)
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
    const newTotal = newSubtotal + newTax - (inv.discount_amount || 0)
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
    const total = sub + taxAmt - (inv.discount_amount || 0)
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
    const total = Math.max(0, sub + taxAmt - discount)
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
      const newTotal = Math.max(0, sub + taxAmt)
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
    // Mutual exclusion with the cashbook-allocation path (see hasActiveAllocations).
    if (hasActiveAllocations(inv)) {
      toastError('This invoice is paid via cashbook allocation — manage it there, not with Record Payment.')
      return
    }
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

    const { data: pmt, error } = await supabase.from('payments').insert({
      invoice_id: invoiceId,
      amount: foreign,                 // in payForm.currency
      currency: payForm.currency,
      exchange_rate: rate,
      amount_inr: amountInr,           // INR base
      rate_source: rateSource,
      rate_date: rateDate,
      payment_date: payForm.payment_date,
      payment_method: payForm.payment_method,
      reference: payForm.reference || null,
      notes: noteText,
      bank_account_id: payForm.bank_account_id || null,
    }).select().single()

    if (error) { toastError(error.message); setSaving(false); return }

    const newPaid = round2((inv.paid_amount || 0) + appliedInvoiceCcy)  // invoice currency
    const newPaidInr = round2((inv.paid_amount_inr || 0) + amountInr)   // INR base
    const balance = (inv.total_amount || 0) - newPaid
    // Status is driven by the foreign (invoice-currency) balance.
    const newStatus = balance <= 0 ? 'paid' : 'partial'

    await supabase.from('invoices').update({ paid_amount: newPaid, paid_amount_inr: newPaidInr, status: newStatus }).eq('id', invoiceId)
    const prevPaid = inv.paid_amount || 0
    const prevPaidInr = inv.paid_amount_inr || 0
    const prevStatus = inv.status
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, paid_amount: newPaid, paid_amount_inr: newPaidInr, status: newStatus, payments: [...(i.payments || []), pmt] }
      : i
    ))
    const label = isAdvancePayment ? `Advance ${fmt(foreign, payForm.currency)} recorded` : `Payment of ${fmt(foreign, payForm.currency)} recorded`
    success(label, undefined, 5000, {
      label: 'Undo',
      onClick: async () => {
        await supabase.from('payments').delete().eq('id', pmt.id)
        await supabase.from('invoices').update({ paid_amount: prevPaid, paid_amount_inr: prevPaidInr, status: prevStatus }).eq('id', invoiceId)
        setInvoices(prev => prev.map(i => i.id === invoiceId
          ? { ...i, paid_amount: prevPaid, paid_amount_inr: prevPaidInr, status: prevStatus, payments: (i.payments || []).filter(p => p.id !== pmt.id) }
          : i
        ))
      },
    })
    setPayForm({ amount: '', currency: (inv.currency || 'INR') as Currency, rate: '', amountInr: '', rateSource: 'settings', payment_date: new Date().toISOString().split('T')[0], payment_method: 'bank_transfer', reference: '', notes: '', bank_account_id: '' })
    setIsAdvancePayment(false)
    setPanelMode('detail')
    setSaving(false)
  }

  function confirmDelete(invoiceId: string) {
    const inv = invoices.find(i => i.id === invoiceId)
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
      const inv = invoices.find(i => i.id === invoiceId)
      const taskIds = (inv?.items || []).map(it => it.task_id).filter(Boolean) as string[]
      if (taskIds.length) await supabase.from('tasks').update({ status: 'done' }).in('id', taskIds)
      await supabase.from('cashbook_invoice_allocations').delete().eq('invoice_id', invoiceId)
      await supabase.from('invoice_items').delete().eq('invoice_id', invoiceId)
      await supabase.from('payments').delete().eq('invoice_id', invoiceId)
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
  async function handleBulkStatusUpdate(newStatus: string) {
    if (selectedForBulk.size === 0) return
    setIsUpdatingBulk(true)

    const idsToUpdate = Array.from(selectedForBulk)

    // NOTE: invoices has no `sent_at` column (only `updated_at`) — writing
    // sent_at 400s the whole batch, which is why bulk Mark Sent never worked.
    const baseUpdates: any = { status: newStatus, updated_at: new Date().toISOString() }

    // For 'sent', auto-fill a due date (today + 30 days, same as the single-
    // invoice flow) on any selected invoice that lacks one — instead of refusing
    // the whole batch. A bulk .update().in() can only write one value, so split:
    // invoices missing a due date get it set in their own update.
    let dueStr: string | null = null
    let missingDueIds: string[] = []
    if (newStatus === 'sent') {
      missingDueIds = invoices.filter(i => idsToUpdate.includes(i.id) && !i.due_date).map(i => i.id)
      if (missingDueIds.length) {
        const dd = new Date(); dd.setDate(dd.getDate() + 30)
        dueStr = dd.toISOString().split('T')[0]
      }
    }

    let error: { message: string } | null = null
    if (missingDueIds.length && dueStr) {
      const r = await supabase.from('invoices').update({ ...baseUpdates, due_date: dueStr }).in('id', missingDueIds)
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
      setInvoices(prev => prev.map(i => {
        if (!idsToUpdate.includes(i.id)) return i
        const patch: any = { ...baseUpdates }
        if (dueStr && missingDueIds.includes(i.id)) patch.due_date = dueStr
        return { ...i, ...patch }
      }))
      setSelectedForBulk(new Set())
      success(
        `Updated ${idsToUpdate.length} invoice(s) to ${newStatus}`,
        missingDueIds.length ? `${missingDueIds.length} due date(s) set to +30 days` : undefined,
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
      issue_date: newForm.issue_date, due_date: newForm.due_date || null,
      currency: newForm.currency, total_amount: subtotal, paid_amount: 0,
      notes: newForm.notes || null,
    }).select('*, client:clients(id,name,code,phone,email)').single()

    if (error) { toastError(error.message); setSaving(false); return }

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
    setNewForm({ client_id: '', currency: 'INR', issue_date: new Date().toISOString().split('T')[0], due_date: '', notes: '', items: [{ description: '', quantity: 1, unit_price: 0, total: 0, service_id: '' }] })
    success('Invoice created')
    setSaving(false)
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
      .select('id, title, task_date, billing_amount, billing_amount_inr, currency, status, service:services(name)')
      .eq('client_id', genForm.client_id)
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
    const client = clients.find(c => c.id === genForm.client_id)
    const from   = genForm.mode === 'day' ? genForm.specific_date : genForm.date_from
    const to     = genForm.mode === 'day' ? genForm.specific_date : genForm.date_to

    const clientCode = client?.code || 'CLI'
    const today = new Date()

    // Determine the invoice date based on the billing period, same as historical batch generate
    const fromDateObj = new Date(from || today.toISOString())
    const taskMonth = `${fromDateObj.getFullYear()}-${String(fromDateObj.getMonth() + 1).padStart(2, '0')}`
    const invoiceDate = getInvoiceDateForTaskMonth(taskMonth)

    const { invoiceNumber: invNum, sequenceMonth } =
      await generateInvoiceNumber(supabase, invoiceDate, clientCode)

    // Customer invoices bill in the task's OWN currency, so line amounts come
    // from billing_amount (foreign), NOT billing_amount_inr (the internal INR
    // base used only for contributions/payroll/analytics). Fallback keeps
    // legacy rows that only have the INR column working.
    const taskAmt = (t: any) => t.billing_amount ?? t.billing_amount_inr ?? 0
    const subtotal = selected.reduce((s, t) => s + taskAmt(t), 0)
    // Base insert — columns that always exist
    const { data: inv, error } = await supabase.from('invoices').insert({
      invoice_number: invNum, client_id: genForm.client_id, status: 'draft',
      issue_date: invoiceDate.toISOString().split('T')[0],
      total_amount: subtotal, paid_amount: 0,
      currency: client?.default_currency || 'INR',
    }).select('*, client:clients(id,name,code,phone,email,address)').single()

    if (error) { toastError(error.message); setSaving(false); return }

    // Update extended columns if migration has been run (ignore error if columns don't exist yet)
    await supabase.from('invoices').update({
      billing_period_start: from, billing_period_end: to,
      subtotal, tax_rate: 0, tax_amount: 0, discount_amount: 0, previous_balance: 0,
      invoice_sequence_month: sequenceMonth,
      exchange_rate: creationRate(client?.default_currency || 'INR'), paid_amount_inr: 0,
    }).eq('id', inv.id)

    await supabase.from('invoice_items').insert(
      selected.map((t, idx) => ({
        invoice_id: inv.id, task_id: t.id,
        description: t.title, quantity: 1,
        unit_price: taskAmt(t), total: taskAmt(t),
        currency: t.currency || 'INR', display_order: idx,
      }))
    )

    const { data: full } = await supabase.from('invoices')
      .select('*, client:clients(id,name,code,phone,email,address), items:invoice_items(*, task:tasks(id,title,task_date,status,billing_amount_inr,currency), service:services(id,name)), payments(*)')
      .eq('id', inv.id).single()

    setInvoices(prev => [full as any, ...prev])
    setSelectedId(inv.id); setPanelMode('detail')
    setGenTasks([]); setGenSelectedIds(new Set())
    success(`Invoice ${invNum} created with ${selected.length} items`)
    setSaving(false)
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
      const clientName = t.client?.name || 'Unknown'
      const clientCode = t.client?.code || 'CLI'
      const month = t.task_date ? t.task_date.slice(0, 7) : 'unknown'
      const key = `${clientId}__${month}`
      if (!groupMap[key]) {
        groupMap[key] = {
          key, client_id: clientId, client_name: clientName,
          client_code: clientCode, month, taskCount: 0, total: 0,
          currency: t.client?.default_currency || 'INR',
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
      const monthEnd = new Date(yr, mo, 0).toISOString().split('T')[0]
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
        // Use proper billing cycle: tasks in Aug → invoice issued Sep 1
        const invoiceDate = getInvoiceDateForTaskMonth(group.month)
        const billingPeriod = buildBillingPeriod(group.month)
        const { invoiceNumber: invNum, sequenceMonth } =
          await generateInvoiceNumber(supabase, invoiceDate, group.client_code)

        const { data: inv, error } = await supabase.from('invoices').insert({
          invoice_number: invNum,
          client_id: group.client_id,
          status: 'draft',
          issue_date: invoiceDate.toISOString().split('T')[0],
          total_amount: group.total,
          paid_amount: 0,
          currency: group.currency || 'INR',
        }).select('id').single()

        if (error || !inv) { errorCount++; continue }

        // Extended columns (ignore if not migrated)
        await supabase.from('invoices').update({
          billing_period_start: billingPeriod.billing_period_start,
          billing_period_end: billingPeriod.billing_period_end,
          billing_period_label: billingPeriod.billing_period_label,
          invoice_sequence_month: sequenceMonth,
          subtotal: group.total, tax_rate: 0, tax_amount: 0, discount_amount: 0, previous_balance: 0,
          exchange_rate: creationRate(group.currency || 'INR'), paid_amount_inr: 0,
        }).eq('id', inv.id)

        // Fetch task details for items
        const { data: taskDetails } = await supabase
          .from('tasks')
          .select('id, title, billing_amount, billing_amount_inr, currency')
          .in('id', group.taskIds)

        if (taskDetails?.length) {
          await supabase.from('invoice_items').insert(
            taskDetails.map((t: any, idx: number) => {
              const amt = t.billing_amount ?? t.billing_amount_inr ?? 0
              return {
                invoice_id: inv.id, task_id: t.id,
                description: t.title, quantity: 1,
                unit_price: amt, total: amt,
                currency: t.currency || 'INR', display_order: idx,
              }
            })
          )
        }
        // Auto-add unbilled client expense outflows for the same task month
        const [taskYr, taskMo] = group.month.split('-').map(Number)
        const monthStart = group.month + '-01'
        const monthEnd = new Date(taskYr, taskMo, 0).toISOString().split('T')[0]
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
            const invCur = group.currency || 'INR'
            const invRate = creationRate(invCur)
            let expTotal = 0
            const expRows = toAddExp.map((e: any) => {
              const amtInInvCur = invCur === 'INR' ? e.amount_inr : round2(e.amount_inr / (invRate || 1))
              expTotal += amtInInvCur
              return {
                invoice_id: inv.id,
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
            // Update invoice total to include auto-added expenses
            const newTotal = round2(group.total + expTotal)
            await supabase.from('invoices').update({ total_amount: newTotal, subtotal: newTotal }).eq('id', inv.id)
          }
        }

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

  // ── Statement generator ────────────────────────────────────────────────────
  function printStatement() {
    // Determine date range
    let from = '', to = '', periodLabel = ''
    if (stmtForm.mode === 'month') {
      from = stmtForm.month + '-01'
      const d = new Date(stmtForm.month + '-01')
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      to = `${stmtForm.month}-${lastDay}`
      periodLabel = new Date(from + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    } else if (stmtForm.mode === 'year') {
      from = `${stmtForm.year}-01-01`
      to   = `${stmtForm.year}-12-31`
      periodLabel = stmtForm.year
    } else if (stmtForm.mode === 'day') {
      from = to = stmtForm.specific_date
      periodLabel = fmtDate(stmtForm.specific_date)
    } else {
      from = stmtForm.date_from; to = stmtForm.date_to
      periodLabel = `${fmtDate(from)} – ${fmtDate(to)}`
    }

    const client = stmtForm.client_id ? clients.find(c => c.id === stmtForm.client_id) : null
    const stmtInvoices = invoices.filter(inv => {
      if (stmtForm.client_id && inv.client_id !== stmtForm.client_id) return false
      const d = inv.issue_date || inv.created_at?.slice(0, 10) || ''
      return d >= from && d <= to
    }).sort((a, b) => (a.issue_date || '').localeCompare(b.issue_date || ''))

    const NAVY    = companySettings.invoice_primary_color || '#1a2744'
    const ACCENT  = companySettings.invoice_accent_color  || '#243459'
    const FONT    = companySettings.invoice_font          || 'Arial, Helvetica, sans-serif'
    const coName  = companySettings.company_name          || 'cirqle'
    const coTag   = companySettings.company_tagline       || 'Get Budget Designs'
    const logoUrl = companySettings.logo_url_light || companySettings.logo_url || ''
    const showTag = companySettings.invoice_show_tagline  !== 'false'

    const stmtLogoBlock = logoUrl
      ? `<img src="${logoUrl}" alt="logo" style="height:32px;object-fit:contain;display:inline-block;vertical-align:middle;margin-right:8px"/>`
      : `<svg width="28" height="28" viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:6px">
           <circle cx="21" cy="21" r="20" fill="none" stroke="${NAVY}" stroke-width="2.5"/>
           <circle cx="21" cy="21" r="14" fill="${NAVY}"/>
           <text x="21" y="26" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">c</text>
         </svg>`

    function dd(d?: string) {
      if (!d) return '—'
      const dt = new Date(d + 'T00:00:00')
      return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`
    }
    function inr(n: number, c = client?.default_currency || 'INR') {
      return getCurrencySymbol(c as Currency) + ' ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    const totalBilled  = stmtInvoices.reduce((s, i) => s + (i.total_amount || 0), 0)
    const totalPaid    = stmtInvoices.reduce((s, i) => s + (i.paid_amount  || 0), 0)
    const totalBalance = totalBilled - totalPaid

    const invoiceRows = stmtInvoices.map((inv, idx) => {
      const balance = Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0))
      const overdue = isOverdue(inv.due_date || '', inv.status)
      const bg = idx % 2 === 0 ? '#f7f9fc' : '#ffffff'
      const statusLabel = overdue && inv.status !== 'paid' ? 'Overdue' : getStatusLabel(inv.status)
      const statusColor = (overdue && inv.status !== 'paid') || inv.status === 'overdue' ? '#c0392b'
        : inv.status === 'paid' ? '#27ae60'
        : inv.status === 'partial' ? '#e67e22'
        : '#555'
      return `
        <tr style="background:${bg}">
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px;font-family:monospace;color:#555">${inv.invoice_number}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px;white-space:nowrap">${dd(inv.issue_date)}</td>
          ${!stmtForm.client_id ? `<td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px">${inv.client?.name || '—'}</td>` : ''}
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px;text-align:right">${inr(inv.total_amount || 0)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px;text-align:right;color:#27ae60">${inr(inv.paid_amount || 0)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px;text-align:right;font-weight:600;color:${balance > 0 ? '#c0392b' : '#27ae60'}">${inr(balance)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px;text-align:center;color:${statusColor};font-weight:600">${statusLabel}</td>
        </tr>`
    }).join('')

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Statement – ${client?.name || 'All Clients'} – ${periodLabel}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family: ${FONT}; color: #222; background:#fff }
    @page { margin: 15mm 12mm; size: A4 portrait }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact } }
  </style>
</head>
<body style="padding:24px 28px;max-width:800px;margin:0 auto">

  <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
    <tr>
      <td style="vertical-align:top">
        <div style="display:flex;align-items:center">
          ${stmtLogoBlock}
          <div>
            <div style="font-size:22px;font-weight:900;color:${NAVY}">${coName}</div>
            ${showTag ? `<div style="font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase">${coTag}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:26px;font-weight:900;color:${NAVY};letter-spacing:2px;text-transform:uppercase">STATEMENT</div>
        <div style="font-size:12px;color:#555;margin-top:2px">Period: <strong>${periodLabel}</strong></div>
      </td>
    </tr>
  </table>
  <div style="height:3px;background:linear-gradient(90deg,${NAVY} 0%,${ACCENT} 60%,#e0e7f0 100%);border-radius:2px;margin-bottom:16px"></div>

  ${client ? `
  <div style="margin-bottom:14px;padding:10px 14px;background:#f7f9fc;border:1px solid #e0e7f0;border-radius:6px">
    <div style="font-size:10px;color:${NAVY};font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:2px">Account</div>
    <div style="font-size:15px;font-weight:700;color:${NAVY}">${client.name}</div>
    ${client.phone ? `<div style="font-size:11px;color:#555">${client.phone}</div>` : ''}
    ${client.email ? `<div style="font-size:11px;color:#555">${client.email}</div>` : ''}
  </div>` : `<div style="margin-bottom:14px;font-size:13px;color:#555"><strong>All Clients</strong></div>`}

  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <thead>
      <tr style="background:${NAVY}">
        <th style="padding:8px 10px;text-align:left;color:white;font-size:11px">Invoice #</th>
        <th style="padding:8px 10px;text-align:left;color:white;font-size:11px;white-space:nowrap">Date</th>
        ${!stmtForm.client_id ? `<th style="padding:8px 10px;text-align:left;color:white;font-size:11px">Client</th>` : ''}
        <th style="padding:8px 10px;text-align:right;color:white;font-size:11px">Billed</th>
        <th style="padding:8px 10px;text-align:right;color:white;font-size:11px">Paid</th>
        <th style="padding:8px 10px;text-align:right;color:white;font-size:11px">Balance</th>
        <th style="padding:8px 10px;text-align:center;color:white;font-size:11px">Status</th>
      </tr>
    </thead>
    <tbody>
      ${invoiceRows || `<tr><td colspan="7" style="padding:20px;text-align:center;color:#999;font-size:12px">No invoices in this period</td></tr>`}
    </tbody>
  </table>

  <table style="width:100%;border-collapse:collapse">
    <tr>
      <td style="width:60%"></td>
      <td style="width:40%">
        <table style="width:100%;border-collapse:collapse">
          <tr style="border-bottom:1px solid #e8edf5">
            <td style="padding:7px 12px;font-size:12px;color:#555">Total Billed</td>
            <td style="padding:7px 12px;text-align:right;font-size:12px;font-weight:600">${inr(totalBilled)}</td>
          </tr>
          <tr style="border-bottom:1px solid #e8edf5">
            <td style="padding:7px 12px;font-size:12px;color:#27ae60">Total Received</td>
            <td style="padding:7px 12px;text-align:right;font-size:12px;font-weight:600;color:#27ae60">${inr(totalPaid)}</td>
          </tr>
          <tr style="background:${NAVY}">
            <td style="padding:10px 12px;font-size:13px;font-weight:700;color:white">Balance Outstanding</td>
            <td style="padding:10px 12px;text-align:right;font-size:14px;font-weight:900;color:white">: &nbsp;${inr(totalBalance)}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <div style="margin-top:24px;border-top:1px solid #e8edf5;padding-top:10px;display:flex;justify-content:space-between;align-items:center">
    <div style="font-size:10px;color:#aaa">Generated ${new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' })}</div>
    <div style="display:flex;align-items:center;gap:6px">
      ${stmtLogoBlock}
      <span style="font-size:14px;font-weight:900;color:${NAVY}">${coName}</span>
      ${showTag ? `<span style="font-size:9px;color:#888;font-weight:600;letter-spacing:1px;text-transform:uppercase">${coTag}</span>` : ''}
    </div>
  </div>

</body>
</html>`

    const w = window.open('', '_blank')
    if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400) }
  }

  function printDetailedStatement() {
    // Determine date range (same logic as printStatement)
    let from = '', to = '', periodLabel = ''
    if (stmtForm.mode === 'month') {
      from = stmtForm.month + '-01'
      const d = new Date(stmtForm.month + '-01')
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      to = `${stmtForm.month}-${lastDay}`
      periodLabel = new Date(from + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    } else if (stmtForm.mode === 'year') {
      from = `${stmtForm.year}-01-01`; to = `${stmtForm.year}-12-31`
      periodLabel = stmtForm.year
    } else if (stmtForm.mode === 'day') {
      from = to = stmtForm.specific_date
      periodLabel = fmtDate(stmtForm.specific_date)
    } else {
      from = stmtForm.date_from; to = stmtForm.date_to
      periodLabel = `${fmtDate(from)} – ${fmtDate(to)}`
    }

    const client = stmtForm.client_id ? clients.find(c => c.id === stmtForm.client_id) : null
    const stmtInvoices = invoices.filter(inv => {
      if (stmtForm.client_id && inv.client_id !== stmtForm.client_id) return false
      const d = inv.issue_date || inv.created_at?.slice(0, 10) || ''
      return d >= from && d <= to
    }).sort((a, b) => (a.issue_date || '').localeCompare(b.issue_date || ''))

    const NAVY = companySettings.invoice_primary_color || '#1a2744'
    const FONT = companySettings.invoice_font || 'Arial, Helvetica, sans-serif'
    const coName = companySettings.company_name || 'cirqle'
    const logoUrl = companySettings.logo_url || ''
    const showTag = companySettings.invoice_show_tagline !== 'false'
    const coTag = companySettings.company_tagline || ''

    function dd(d?: string) {
      if (!d) return '—'
      const dt = new Date(d + 'T00:00:00')
      return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`
    }
    function inr(n: number, c = client?.default_currency || 'INR') {
      return getCurrencySymbol(c as Currency) + ' ' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    const logoBlock = logoUrl
      ? `<img src="${logoUrl}" alt="logo" style="height:32px;object-fit:contain;display:inline-block;vertical-align:middle;margin-right:8px"/>`
      : `<svg width="28" height="28" viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;margin-right:6px"><circle cx="21" cy="21" r="20" fill="none" stroke="${NAVY}" stroke-width="2.5"/><circle cx="21" cy="21" r="14" fill="${NAVY}"/><text x="21" y="26" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">c</text></svg>`

    // Build detailed rows: for each invoice, emit invoice header row, then line items, then payments, discounts, cancellations
    let runningBalance = 0
    let allRows = ''

    for (const inv of stmtInvoices) {
      const invTotal = inv.total_amount || 0
      const discount = inv.discount_amount || 0
      const prevBal = inv.previous_balance || 0
      const sortedItems = [...(inv.items || [])].sort((a, b) => a.display_order - b.display_order)

      // Invoice header row
      allRows += `
        <tr style="background:#eef2ff">
          <td colspan="4" style="padding:8px 10px;border-bottom:1px solid #d1d9f0;font-size:11px;font-weight:700;color:${NAVY}">
            📄 ${inv.invoice_number} — ${inv.client?.name || ''} &nbsp; <span style="font-weight:400;color:#555">Issued ${dd(inv.issue_date)}${inv.due_date ? ' · Due ' + dd(inv.due_date) : ''}</span>
          </td>
          <td style="padding:8px 10px;border-bottom:1px solid #d1d9f0;text-align:right;font-size:11px;font-weight:700;color:${NAVY}">${inr(invTotal)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #d1d9f0;text-align:right;font-size:11px;color:#555">Invoice Total</td>
        </tr>`

      // Previous balance carry-over
      if (prevBal > 0) {
        runningBalance += prevBal
        allRows += `
          <tr style="background:#fff8f0">
            <td style="padding:5px 10px 5px 24px;border-bottom:1px solid #f0e6d0;font-size:11px;color:#c0392b">↩ Carry-over balance</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e6d0;font-size:11px;color:#888">—</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e6d0;font-size:11px;color:#888">—</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e6d0;text-align:right;font-size:11px;color:#c0392b">+${inr(prevBal)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e6d0;text-align:right;font-size:11px;font-weight:600;color:#c0392b">${inr(runningBalance)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e6d0;font-size:10px;color:#aaa">Prev. balance</td>
          </tr>`
      }

      // Line items (tasks)
      for (const it of sortedItems) {
        runningBalance += it.total
        const isCancelled = it.task?.status === 'cancelled'
        allRows += `
          <tr style="background:${isCancelled ? '#fff5f5' : '#ffffff'}">
            <td style="padding:5px 10px 5px 24px;border-bottom:1px solid #e8edf5;font-size:11px;color:${isCancelled ? '#c0392b' : '#333'};${isCancelled ? 'text-decoration:line-through;' : ''}">
              ${isCancelled ? '✗ ' : ''}${it.description}
            </td>
            <td style="padding:5px 10px;border-bottom:1px solid #e8edf5;font-size:11px;color:#888;white-space:nowrap">${it.task?.task_date ? dd(it.task.task_date) : '—'}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #e8edf5;font-size:11px;color:#888">${it.service?.name || '—'}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #e8edf5;text-align:right;font-size:11px;color:${isCancelled ? '#c0392b' : '#333'}">${isCancelled ? '—' : inr(it.total)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #e8edf5;text-align:right;font-size:11px;font-weight:600;color:${isCancelled ? '#aaa' : '#333'}">${isCancelled ? '—' : inr(runningBalance)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #e8edf5;font-size:10px;color:${isCancelled ? '#c0392b' : '#27ae60'}">${isCancelled ? 'Cancelled' : 'Billed'}</td>
          </tr>`
        if (isCancelled) runningBalance -= it.total // cancelled items don't contribute
      }

      // Discount
      if (discount > 0) {
        runningBalance -= discount
        allRows += `
          <tr style="background:#fffbf0">
            <td style="padding:5px 10px 5px 24px;border-bottom:1px solid #f0e8c0;font-size:11px;color:#d4820a">🏷 Discount applied</td>
            <td colspan="2" style="padding:5px 10px;border-bottom:1px solid #f0e8c0;font-size:11px;color:#888">—</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e8c0;text-align:right;font-size:11px;color:#d4820a">−${inr(discount)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e8c0;text-align:right;font-size:11px;font-weight:600;color:#333">${inr(runningBalance)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #f0e8c0;font-size:10px;color:#d4820a">Discount</td>
          </tr>`
      }

      // Payments
      for (const pmt of (inv.payments || [])) {
        const pmtAmt = pmt.amount ?? 0
        runningBalance -= pmtAmt
        const methodLabels: Record<string, string> = { bank_transfer: 'Bank Transfer', cash: 'Cash', upi: 'UPI', cheque: 'Cheque', online: 'Online', other: 'Other' }
        allRows += `
          <tr style="background:#f0fff4">
            <td style="padding:5px 10px 5px 24px;border-bottom:1px solid #c3e6cb;font-size:11px;color:#27ae60">✓ Payment received</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;font-size:11px;color:#888;white-space:nowrap">${dd(pmt.payment_date)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;font-size:11px;color:#888">${methodLabels[pmt.payment_method] || pmt.payment_method}${pmt.reference ? ' · ' + pmt.reference : ''}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;text-align:right;font-size:11px;color:#27ae60">−${inr(pmtAmt)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;text-align:right;font-size:11px;font-weight:600;color:${runningBalance > 0 ? '#c0392b' : '#27ae60'}">${inr(Math.max(0, runningBalance))}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;font-size:10px;color:#27ae60">Paid</td>
          </tr>`
      }
    }

    const totalBilled = stmtInvoices.reduce((s, i) => s + (i.total_amount || 0), 0)
    const totalPaid   = stmtInvoices.reduce((s, i) => s + (i.paid_amount  || 0), 0)
    const totalDisc   = stmtInvoices.reduce((s, i) => s + (i.discount_amount || 0), 0)
    const totalBalance = Math.max(0, totalBilled - totalPaid)

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Detailed Statement – ${client?.name || 'All Clients'} – ${periodLabel}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family: ${FONT}; color: #222; background:#fff }
    @page { margin: 12mm 10mm; size: A4 portrait }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact } }
    table { border-collapse: collapse; width: 100% }
  </style>
</head>
<body style="padding:20px 24px;max-width:900px;margin:0 auto">

  <table style="margin-bottom:16px">
    <tr>
      <td style="vertical-align:top">
        <div style="display:flex;align-items:center">
          ${logoBlock}
          <div>
            <div style="font-size:20px;font-weight:900;color:${NAVY}">${coName}</div>
            ${showTag && coTag ? `<div style="font-size:9px;color:#888;letter-spacing:1px;text-transform:uppercase">${coTag}</div>` : ''}
          </div>
        </div>
      </td>
      <td style="text-align:right;vertical-align:top">
        <div style="font-size:18px;font-weight:900;color:${NAVY};letter-spacing:-0.5px">DETAILED ACCOUNT STATEMENT</div>
        <div style="font-size:11px;color:#555;margin-top:2px">${client ? `Client: <strong>${client.name}</strong>` : '<strong>All Clients</strong>'}</div>
        <div style="font-size:11px;color:#555">Period: <strong>${periodLabel}</strong></div>
      </td>
    </tr>
  </table>

  <!-- Summary cards -->
  <table style="margin-bottom:16px;border:1px solid #e0e7f0;border-radius:6px;overflow:hidden">
    <tr>
      <td style="padding:10px 16px;background:#f7f9fc;border-right:1px solid #e0e7f0;text-align:center">
        <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Total Invoiced</div>
        <div style="font-size:16px;font-weight:800;color:${NAVY};margin-top:2px">${inr(totalBilled)}</div>
      </td>
      <td style="padding:10px 16px;background:#f7f9fc;border-right:1px solid #e0e7f0;text-align:center">
        <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Total Paid</div>
        <div style="font-size:16px;font-weight:800;color:#27ae60;margin-top:2px">${inr(totalPaid)}</div>
      </td>
      ${totalDisc > 0 ? `
      <td style="padding:10px 16px;background:#f7f9fc;border-right:1px solid #e0e7f0;text-align:center">
        <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Discounts Given</div>
        <div style="font-size:16px;font-weight:800;color:#d4820a;margin-top:2px">−${inr(totalDisc)}</div>
      </td>` : ''}
      <td style="padding:10px 16px;background:${totalBalance > 0 ? '#fff5f5' : '#f0fff4'};text-align:center">
        <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.5px">Balance Due</div>
        <div style="font-size:16px;font-weight:800;color:${totalBalance > 0 ? '#c0392b' : '#27ae60'};margin-top:2px">${inr(totalBalance)}</div>
      </td>
    </tr>
  </table>

  <!-- Detail table -->
  <table>
    <thead>
      <tr style="background:${NAVY};color:white">
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Description</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Date</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Details</th>
        <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Amount</th>
        <th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Balance</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">Type</th>
      </tr>
    </thead>
    <tbody>
      ${allRows || `<tr><td colspan="6" style="padding:20px;text-align:center;color:#888;font-size:12px">No transactions found in this period.</td></tr>`}
    </tbody>
    <tfoot>
      <tr style="background:#f0f4ff;border-top:2px solid ${NAVY}">
        <td colspan="3" style="padding:10px;font-size:12px;font-weight:700;color:${NAVY}">Closing Balance</td>
        <td style="padding:10px;text-align:right;font-size:12px;color:#333">&nbsp;</td>
        <td style="padding:10px;text-align:right;font-size:14px;font-weight:800;color:${totalBalance > 0 ? '#c0392b' : '#27ae60'}">${inr(totalBalance)}</td>
        <td style="padding:10px;font-size:10px;color:#555">${totalBalance > 0 ? 'Amount due' : 'Settled'}</td>
      </tr>
    </tfoot>
  </table>

  <div style="margin-top:16px;font-size:9px;color:#aaa;text-align:center;border-top:1px solid #e8edf5;padding-top:10px">
    Generated by ${coName} · ${new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' })}
  </div>
</body>
</html>`

    const w = window.open('', '_blank', 'width=900,height=900')
    if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400) }
  }

  function exportDetailedStatementCSV() {
    // Determine date range (same logic as printDetailedStatement)
    let from = '', to = '', periodLabel = ''
    if (stmtForm.mode === 'month') {
      from = stmtForm.month + '-01'
      const d = new Date(stmtForm.month + '-01')
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      to = `${stmtForm.month}-${lastDay}`
      periodLabel = new Date(from + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    } else if (stmtForm.mode === 'year') {
      from = `${stmtForm.year}-01-01`; to = `${stmtForm.year}-12-31`
      periodLabel = stmtForm.year
    } else if (stmtForm.mode === 'day') {
      from = to = stmtForm.specific_date
      periodLabel = fmtDate(stmtForm.specific_date)
    } else {
      from = stmtForm.date_from; to = stmtForm.date_to
      periodLabel = from && to ? `${fmtDate(from)} – ${fmtDate(to)}` : 'Custom range'
    }

    const client = stmtForm.client_id ? clients.find(c => c.id === stmtForm.client_id) : null
    const stmtInvoices = invoices.filter(inv => {
      if (stmtForm.client_id && inv.client_id !== stmtForm.client_id) return false
      const d = inv.issue_date || inv.created_at?.slice(0, 10) || ''
      return d >= from && d <= to
    }).sort((a, b) => (a.issue_date || '').localeCompare(b.issue_date || ''))

    // Normalize ledger rows into custom array structure
    const ledgerRows: StatementLedgerRow[] = []
    let runningBalance = 0

    for (const inv of stmtInvoices) {
      const invTotal = inv.total_amount || 0
      const discount = inv.discount_amount || 0
      const prevBal = inv.previous_balance || 0
      const sortedItems = [...(inv.items || [])].sort((a, b) => a.display_order - b.display_order)
      const clientName = inv.client?.name || ''

      // Invoice Header Info Row
      ledgerRows.push({
        invoiceNumber: inv.invoice_number,
        client: clientName,
        date: inv.issue_date ? inv.issue_date : undefined,
        type: 'Invoice Header',
        description: `Invoice ${inv.invoice_number} Issued`,
        details: inv.due_date ? `Due ${inv.due_date}` : '',
        amount: invTotal,
        balance: runningBalance
      })

      // Previous Balance Carry-over
      if (prevBal > 0) {
        runningBalance += prevBal
        ledgerRows.push({
          invoiceNumber: inv.invoice_number,
          client: clientName,
          date: inv.issue_date ? inv.issue_date : undefined,
          type: 'Prev. Balance',
          description: '↩ Carry-over balance',
          details: 'Previous balance carry-over',
          amount: prevBal,
          balance: runningBalance
        })
      }

      // Line items (tasks)
      for (const it of sortedItems) {
        runningBalance += it.total
        const isCancelled = it.task?.status === 'cancelled'
        
        ledgerRows.push({
          invoiceNumber: inv.invoice_number,
          client: clientName,
          date: it.task?.task_date || inv.issue_date || undefined,
          type: isCancelled ? 'Cancelled' : 'Billed',
          description: (isCancelled ? '✗ ' : '') + it.description,
          details: it.service?.name || '',
          amount: isCancelled ? 0 : it.total,
          balance: isCancelled ? runningBalance - it.total : runningBalance
        })

        if (isCancelled) {
          runningBalance -= it.total
        }
      }

      // Discount
      if (discount > 0) {
        runningBalance -= discount
        ledgerRows.push({
          invoiceNumber: inv.invoice_number,
          client: clientName,
          date: inv.issue_date || undefined,
          type: 'Discount',
          description: '🏷 Discount applied',
          details: '',
          amount: -discount,
          balance: runningBalance
        })
      }

      // Payments
      for (const pmt of (inv.payments || [])) {
        const pmtAmt = pmt.amount ?? 0
        runningBalance -= pmtAmt
        const methodLabels: Record<string, string> = {
          bank_transfer: 'Bank Transfer', cash: 'Cash', upi: 'UPI',
          cheque: 'Cheque', online: 'Online', other: 'Other'
        }
        const detailsText = [
          methodLabels[pmt.payment_method] || pmt.payment_method,
          pmt.reference ? pmt.reference : null
        ].filter(Boolean).join(' · ')

        ledgerRows.push({
          invoiceNumber: inv.invoice_number,
          client: clientName,
          date: pmt.payment_date || undefined,
          type: 'Payment',
          description: '✓ Payment received',
          details: detailsText,
          amount: -pmtAmt,
          balance: Math.max(0, runningBalance)
        })
      }
    }

    // Escape CSV utility
    function escapeCSVValue(val: any): string {
      if (val === undefined || val === null) return ''
      let str = String(val)
      str = str.replace(/"/g, '""')
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str}"`
      }
      return str
    }

    // Compile CSV Content
    const headers = ['Invoice Number', 'Client', 'Date', 'Type', 'Description', 'Details', 'Amount', 'Balance']
    const csvLines = [headers.join(',')]

    for (const row of ledgerRows) {
      const line = [
        escapeCSVValue(row.invoiceNumber),
        escapeCSVValue(row.client),
        escapeCSVValue(row.date),
        escapeCSVValue(row.type),
        escapeCSVValue(row.description),
        escapeCSVValue(row.details),
        row.amount !== undefined ? row.amount.toFixed(2) : '',
        row.balance !== undefined ? row.balance.toFixed(2) : ''
      ]
      csvLines.push(line.join(','))
    }

    // Append closing balance row for clarity if invoices exist
    if (ledgerRows.length > 0) {
      csvLines.push([
        '', '', '', 'Summary', 'Closing Balance', '', '', runningBalance.toFixed(2)
      ].map(escapeCSVValue).join(','))
    }

    const csvString = csvLines.join('\n')
    
    // Auto-download attachment with UTF-8 BOM
    const blob = new Blob(['\uFEFF' + csvString], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const finalClientName = client?.name || 'All_Clients'
    const cleanClientName = finalClientName.replace(/[^a-z0-9]/gi, '_').toLowerCase()
    const cleanPeriodLabel = periodLabel.replace(/[^a-z0-9\-_]/gi, '_').toLowerCase()
    
    link.setAttribute('href', url)
    link.setAttribute('download', `statement_${cleanClientName}_${cleanPeriodLabel}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
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
      .select('id, title, task_date, billing_amount_inr, currency, cancelled_by, cancellation_notes, honor_contributions, loss_amount, completion_pct, client:clients(id, name), service:services(name)')
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

  async function refreshInvoice(invoiceId: string) {
    const { data } = await supabase.from('invoices')
      .select('*, client:clients(id,name,code,phone,email), items:invoice_items(*, task:tasks(id,title,task_date,status,billing_amount_inr,currency), service:services(id,name)), payments(*)')
      .eq('id', invoiceId).single()
    if (data) setInvoices(prev => prev.map(i => i.id === invoiceId ? data as any : i))
  }

  // ── Invoice print-design helpers ──────────────────────────────────────────
  /** Darken (f<1) a hex color by multiplying channels. */
  function shadeHex(hex: string, f: number): string {
    const h = hex.replace('#', '')
    if (h.length !== 6) return hex
    return '#' + [0, 2, 4].map(i => {
      const v = Math.max(0, Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * f)))
      return v.toString(16).padStart(2, '0')
    }).join('')
  }
  /** Tint a hex color toward white by fraction f (0..1). */
  function tintHex(hex: string, f: number): string {
    const h = hex.replace('#', '')
    if (h.length !== 6) return hex
    return '#' + [0, 2, 4].map(i => {
      const c = parseInt(h.slice(i, i + 2), 16)
      const v = Math.max(0, Math.min(255, Math.round(c + (255 - c) * f)))
      return v.toString(16).padStart(2, '0')
    }).join('')
  }
  /** Sync QR SVG (errorCorrection H so the centre badge can overlay). */
  function qrSvgBlock(text: string, accent: string, size = 104): string {
    try {
      const qr = QRCode.create(text, { errorCorrectionLevel: 'H' })
      const n = qr.modules.size
      const cell = size / n
      let rects = ''
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.modules.get(r, c)) {
            rects += `<rect x="${(c * cell).toFixed(2)}" y="${(r * cell).toFixed(2)}" width="${(cell + 0.05).toFixed(2)}" height="${(cell + 0.05).toFixed(2)}"/>`
          }
        }
      }
      const b = size / 2
      return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="#ffffff"/>
        <g fill="#161616">${rects}</g>
        <rect x="${b - 13}" y="${b - 13}" width="26" height="26" rx="7" fill="${accent}" stroke="#ffffff" stroke-width="2.5"/>
        <text x="${b}" y="${b + 5.5}" text-anchor="middle" font-size="15" font-weight="bold" fill="#ffffff" font-family="Arial, sans-serif">&#8377;</text>
      </svg>`
    } catch {
      return ''
    }
  }

  function buildInvoiceHtml(inv: Invoice, opts?: { autoprint?: boolean }): string {
    // Company info + design from settings
    const co = {
      name:    companySettings.company_name    || 'cirqle',
      phone:   companySettings.company_phone   || '',
      website: companySettings.company_website || '',
      tagline: companySettings.company_tagline || 'Get Budget Designs',
      holder:  companySettings.bank_holder     || '',
      account: companySettings.bank_account    || '',
      ifsc:    companySettings.bank_ifsc       || '',
      upi:     companySettings.bank_upi        || '',
      logoUrl: companySettings.logo_url_light || companySettings.logo_url || '',
      footerText: companySettings.invoice_footer_text || 'Thank you for your Business!',
    }
    const showLogo       = companySettings.invoice_show_logo        !== 'false'
    const showName       = companySettings.invoice_show_company_name !== 'false'
    const showTagline    = companySettings.invoice_show_tagline     !== 'false'
    const showPayInfo    = companySettings.invoice_show_payment_info !== 'false'
    const showContact    = companySettings.invoice_show_phone       !== 'false'
    const showQr         = companySettings.invoice_show_qr          !== 'false'
    const bgStyle        = companySettings.invoice_bg_style || 'none'

    const NAVY       = companySettings.invoice_primary_color || '#1a2744'
    const NAVY_LIGHT = companySettings.invoice_accent_color  || '#243459'
    const FONT       = companySettings.invoice_font          || 'Arial, Helvetica, sans-serif'
    const sortedItems = [...(inv.items || [])].sort((a, b) => a.display_order - b.display_order)
    const subtotal = inv.subtotal || ((inv.total_amount || 0) + (inv.discount_amount || 0) - (inv.tax_amount || 0) - (inv.previous_balance || 0))
    const prevBal  = inv.previous_balance || 0
    const totalDue = subtotal + prevBal
    const discount = inv.discount_amount || 0
    const taxAmt   = inv.tax_amount || 0
    const totalPayable = inv.total_amount || 0

    // Format date as DD/MM/YYYY (header meta)
    function dd(d?: string) {
      if (!d) return ''
      const dt = new Date(d + 'T00:00:00')
      return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`
    }
    // Format date as DD-Mon-YYYY (table rows, matches reference)
    function ddMon(d?: string) {
      if (!d) return ''
      const dt = new Date(d + 'T00:00:00')
      const mon = dt.toLocaleDateString('en-GB', { month: 'short' })
      return `${String(dt.getDate()).padStart(2,'0')}-${mon}-${dt.getFullYear()}`
    }
    function inr(n: number, c = inv.currency || 'INR') {
      return getCurrencySymbol(c as Currency) + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    // Derived design tokens (reference look, brand-driven)
    const ALT_ROW   = tintHex(NAVY_LIGHT, 0.94)         // pale lavender alternate rows
    const HEAD_TOP  = NAVY                              // table header gradient top
    const HEAD_BOT  = shadeHex(NAVY, 0.55)              // table header gradient bottom
    const CELL_BORD = tintHex(NAVY_LIGHT, 0.82)         // faint column/row borders
    const THANK_LT  = NAVY_LIGHT                        // "Thank" light purple
    const THANK_DK  = shadeHex(NAVY_LIGHT, 0.5)         // "you" deep purple
    const THANK_MID = shadeHex(NAVY_LIGHT, 0.78)        // "for your / Business!"

    // Expense items — rendered as a separate "Expenses" section after the item table.
    // Display mode (A/B/C) controls what the client sees; internal costs are never shown in A or C.
    const expenseItems = inv.expense_items || []
    // Per-invoice override → company default → 'mode_a'
    const expensesMode = inv.expenses_mode || companySettings.expense_display_mode || 'mode_a'
    const td = (extra: string) => `padding:9px 10px;border-bottom:1px solid ${CELL_BORD};border-left:1px solid ${CELL_BORD};font-size:13px;${extra}`

    // Build task item rows
    const itemRows = sortedItems.map((it, idx) => {
      const taskDate = it.task?.task_date ? ddMon(it.task.task_date) : ''
      const bg = idx % 2 === 1 ? ALT_ROW : '#ffffff'
      return `
        <tr style="background:${bg}">
          <td style="${td('border-left:none;text-align:center;color:#222')}">${idx + 1}</td>
          <td style="${td('text-align:center;color:#222;white-space:nowrap')}">${taskDate}</td>
          <td style="${td('text-align:left;color:#222')}">${it.description}</td>
          <td style="${td('text-align:center;color:#222')}">${it.quantity}</td>
          <td style="${td('text-align:center;color:#222;white-space:nowrap')}">${inr(it.unit_price)}</td>
          <td style="${td('text-align:center;color:#111;font-weight:700;white-space:nowrap')}">${inr(it.total)}</td>
        </tr>`
    })
    const allItemRows = itemRows.join('')

    // Expenses section block (separate from main item table in all modes)
    const expensesTotal = expenseItems.reduce((s, e) => s + (e.amount || 0), 0)
    const separateExpensesBlock = expenseItems.length > 0 ? (() => {
      const expRows = expenseItems.map((exp, i) => {
        const bg = i % 2 === 1 ? ALT_ROW : '#ffffff'
        const tdE = `padding:8px 10px;border-bottom:1px solid ${CELL_BORD};font-size:12.5px;`
        const hasMarkup = exp.markup_type !== 'none' && (exp.markup_amount || 0) > 0

        if (expensesMode === 'mode_b' && hasMarkup) {
          // Mode B: show cost + markup + total in a sub-table within the cell
          return `<tr style="background:${bg}">
            <td style="${tdE}color:#222">
              <div style="font-weight:600">${exp.description}</div>
              <table style="margin-top:4px;font-size:11px;color:#666;border-collapse:collapse">
                <tr><td style="padding:1px 0">Cost</td><td style="padding:1px 8px">:</td><td style="text-align:right">${inr(exp.original_amount || 0)}</td></tr>
                <tr><td style="padding:1px 0">Markup</td><td style="padding:1px 8px">:</td><td style="text-align:right">${inr(exp.markup_amount || 0)}</td></tr>
              </table>
            </td>
            <td style="${tdE}border-left:1px solid ${CELL_BORD};font-weight:700;text-align:right;white-space:nowrap">${inr(exp.amount)}</td>
          </tr>`
        }
        if (expensesMode === 'mode_c') {
          return `<tr style="background:${bg}">
            <td style="${tdE}color:#222">
              <div style="font-weight:600">${exp.description}</div>
              <div style="font-size:10.5px;color:#888;margin-top:2px;font-style:italic">Reimbursable Expense</div>
            </td>
            <td style="${tdE}border-left:1px solid ${CELL_BORD};font-weight:700;text-align:right;white-space:nowrap">${inr(exp.amount)}</td>
          </tr>`
        }
        // Mode A (default): description + billing amount only
        return `<tr style="background:${bg}">
          <td style="${tdE}color:#222">${exp.description}</td>
          <td style="${tdE}border-left:1px solid ${CELL_BORD};font-weight:700;text-align:right;white-space:nowrap">${inr(exp.amount)}</td>
        </tr>`
      }).join('')
      return `
  <div style="margin-top:18px">
    <div style="font-weight:700;font-size:13px;color:${NAVY};margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em">Expenses</div>
    <table style="width:100%;border-collapse:collapse;border:1px solid ${CELL_BORD}">
      <thead>
        <tr style="background:linear-gradient(to bottom,${HEAD_TOP},${HEAD_BOT})">
          <th style="padding:8px 10px;text-align:left;color:#fff;font-size:12.5px;font-weight:700">Description</th>
          <th style="padding:8px 10px;text-align:right;color:#fff;font-size:12.5px;font-weight:700;white-space:nowrap;border-left:2px solid #fff">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${expRows}
        <tr style="background:#f8f8f8">
          <td style="padding:8px 10px;font-size:12.5px;font-weight:700;color:#111;text-align:right">Expenses Total</td>
          <td style="padding:8px 10px;border-left:1px solid ${CELL_BORD};font-size:13px;font-weight:700;text-align:right;white-space:nowrap">${inr(expensesTotal)}</td>
        </tr>
      </tbody>
    </table>
  </div>`
    })() : ''

    const upiString = co.upi ? `upi://pay?pa=${co.upi}&pn=${encodeURIComponent(co.holder)}&cu=INR` : ''

    // Logo: use uploaded image if available, else SVG icon
    const logoBlock = showLogo
      ? co.logoUrl
        ? `<img src="${co.logoUrl}" alt="logo" style="height:42px;object-fit:contain;display:block"/>`
        : `<svg width="42" height="42" viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg">
             <circle cx="21" cy="21" r="20" fill="none" stroke="${NAVY}" stroke-width="2.5"/>
             <circle cx="21" cy="21" r="14" fill="${NAVY}"/>
             <text x="21" y="26" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">c</text>
           </svg>`
      : ''

    // Payment information — italic block, reference style
    const payRow = (label: string, value: string) => `
      <tr>
        <td style="font-size:11.5px;font-style:italic;color:#222;padding:2.5px 0;white-space:nowrap">${label}</td>
        <td style="padding:2.5px 10px;font-size:11.5px;font-style:italic;color:#222">:</td>
        <td style="font-size:11.5px;font-style:italic;font-weight:700;color:#111">${value}</td>
      </tr>`
    const paymentBlock = showPayInfo && (co.holder || co.account || co.upi) ? `
      <div>
        <div style="font-weight:700;font-style:italic;font-size:13.5px;color:#111;margin-bottom:6px;text-decoration:underline;text-underline-offset:3px">Payment Information</div>
        <table style="border-collapse:collapse">
          ${co.holder  ? payRow('A/C Holder Name', co.holder.toUpperCase()) : ''}
          ${co.account ? payRow('A/C Number', co.account) : ''}
          ${co.ifsc    ? payRow('IFSC Code', co.ifsc) : ''}
          ${co.upi     ? payRow('UPI ID', co.upi) : ''}
        </table>
      </div>` : ''

    // QR (encodes the UPI pay link) with brand centre badge
    const qrBlock = showQr && upiString ? qrSvgBlock(upiString, NAVY_LIGHT) : ''

    // Thank-you block: first two words get the bold two-tone treatment,
    // the rest wraps naturally in a narrow column → matches the reference
    // 3-line layout for the default "Thank you for your Business!" text.
    const ftWords = (co.footerText || '').trim().split(/\s+/)
    const thankBlock = ftWords.length >= 2 ? `
      <div style="font-family:'Poppins',${FONT};max-width:175px;line-height:1.3">
        <div style="font-size:23px;font-weight:700"><span style="color:${THANK_LT}">${ftWords[0]} </span><span style="color:${THANK_DK}">${ftWords[1]}</span></div>
        ${ftWords.length > 2 ? `<div style="font-size:22px;font-weight:500;color:${THANK_MID};text-shadow:0 0 6px #ffffff,0 0 2px #ffffff">${ftWords.slice(2).join(' ')}</div>` : ''}
      </div>` : `
      <div style="font-family:'Poppins',${FONT};max-width:175px;font-size:22px;font-weight:700;color:${THANK_DK}">${co.footerText}</div>`

    const bgCss = bgStyle === 'dots'
      ? `background-image:radial-gradient(circle,${NAVY}1a 1.5px,transparent 1.5px);background-size:18px 18px;`
      : bgStyle === 'diagonal'
      ? `background-image:repeating-linear-gradient(45deg,${NAVY}12 0px,${NAVY}12 1px,transparent 1px,transparent 16px);`
      : ''

    const cornerSvg = bgStyle === 'corner'
      ? `<svg style="position:fixed;top:0;right:0;width:180px;height:180px;pointer-events:none;z-index:0" viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg">
           <path d="M180 0 L180 180 L0 0 Z" fill="${NAVY}" opacity="0.07"/>
           <path d="M180 0 L180 120 L60 0 Z" fill="${NAVY}" opacity="0.07"/>
         </svg>`
      : ''

    // Silk Shade — layered flowing silk-wave ribbons hugging the top & bottom
    // page edges (multiple translucent layers + white highlight streaks, blurred)
    const ACC = NAVY_LIGHT
    const shadeSvg = bgStyle === 'shade'
      ? `<svg style="position:fixed;top:0;left:0;width:100%;height:190px;pointer-events:none;z-index:0" viewBox="0 0 800 190" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
           <defs>
             <linearGradient id="wgT" x1="0" y1="0" x2="1" y2="0.25">
               <stop offset="0" stop-color="${ACC}" stop-opacity="0.20"/>
               <stop offset="0.45" stop-color="${ACC}" stop-opacity="0.08"/>
               <stop offset="0.8" stop-color="${ACC}" stop-opacity="0.18"/>
               <stop offset="1" stop-color="${ACC}" stop-opacity="0.07"/>
             </linearGradient>
             <filter id="wbT1" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>
             <filter id="wbT2" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="2.6"/></filter>
           </defs>
           <g filter="url(#wbT1)">
             <path d="M0 0 H800 V112 C696 158 588 104 470 118 C338 134 222 84 124 120 C72 140 28 132 0 150 Z" fill="url(#wgT)"/>
             <path d="M0 0 H800 V72 C688 124 556 56 424 80 C292 104 168 50 0 104 Z" fill="${ACC}" opacity="0.09"/>
             <path d="M0 0 H800 V34 C648 70 472 26 326 48 C204 66 86 30 0 58 Z" fill="${ACC}" opacity="0.12"/>
             <path d="M800 0 V92 C744 66 668 36 596 6 C664 2 744 0 800 0 Z" fill="${ACC}" opacity="0.16"/>
             <path d="M0 0 H132 C88 28 38 42 0 38 Z" fill="${ACC}" opacity="0.13"/>
           </g>
           <g filter="url(#wbT2)">
             <path d="M0 112 C156 150 348 88 540 110 C664 124 752 102 800 114 L800 121 C752 109 664 131 540 117 C348 95 156 158 0 119 Z" fill="#ffffff" opacity="0.85"/>
             <path d="M0 66 C196 112 416 36 624 70 C700 82 764 68 800 76 L800 83 C764 75 700 89 624 77 C416 43 196 119 0 73 Z" fill="#ffffff" opacity="0.65"/>
             <path d="M30 88 C220 124 430 60 640 88 L640 92 C430 64 220 129 30 92 Z" fill="${ACC}" opacity="0.18"/>
           </g>
         </svg>
         <svg style="position:fixed;bottom:0;left:0;width:100%;height:200px;pointer-events:none;z-index:0" viewBox="0 0 800 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
           <defs>
             <linearGradient id="wgB" x1="0" y1="1" x2="1" y2="0.7">
               <stop offset="0" stop-color="${ACC}" stop-opacity="0.18"/>
               <stop offset="0.5" stop-color="${ACC}" stop-opacity="0.07"/>
               <stop offset="1" stop-color="${ACC}" stop-opacity="0.22"/>
             </linearGradient>
             <filter id="wbB1" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>
             <filter id="wbB2" x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="2.6"/></filter>
           </defs>
           <g filter="url(#wbB1)">
             <path d="M0 200 H800 V96 C676 56 556 116 432 96 C296 74 178 124 84 92 C48 80 18 88 0 72 Z" fill="url(#wgB)"/>
             <path d="M0 200 H800 V136 C672 96 540 152 408 130 C276 108 150 156 0 116 Z" fill="${ACC}" opacity="0.08"/>
             <path d="M0 200 H800 V170 C640 138 460 178 318 158 C198 142 84 172 0 150 Z" fill="${ACC}" opacity="0.12"/>
             <path d="M800 200 V104 C740 134 656 166 576 196 C648 200 740 200 800 200 Z" fill="${ACC}" opacity="0.18"/>
             <path d="M0 200 H148 C96 168 40 152 0 158 Z" fill="${ACC}" opacity="0.14"/>
           </g>
           <g filter="url(#wbB2)">
             <path d="M0 130 C168 92 372 152 568 126 C684 110 756 130 800 118 L800 125 C756 137 684 117 568 133 C372 159 168 99 0 137 Z" fill="#ffffff" opacity="0.85"/>
             <path d="M40 158 C240 122 450 182 660 150 L660 154 C450 187 240 127 40 162 Z" fill="${ACC}" opacity="0.18"/>
             <path d="M0 178 C200 146 420 196 636 168 C700 160 760 172 800 162 L800 169 C760 179 700 167 636 175 C420 203 200 153 0 185 Z" fill="#ffffff" opacity="0.6"/>
           </g>
         </svg>`
      : ''

    // Shade bleeds to the paper edge: zero the @page margin and carry it on the body instead
    const pageMargin = bgStyle === 'shade' ? '0' : '15mm 12mm'
    const bodyPad = bgStyle === 'shade' ? '20mm 16mm 14mm' : '24px 28px'

    // Tagline splits into "Get Budget" / "Designs" (last word bold on its own line)
    const tagWords = (co.tagline || '').trim().split(/\s+/)

    // Inline icons (black, match reference)
    const waIcon = `<svg width="17" height="17" viewBox="0 0 448 512" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:-3px"><path fill="#111" d="M380.9 97.1C339 55.1 283.2 32 223.9 32c-122.4 0-222 99.6-222 222 0 39.1 10.2 77.3 29.6 111L0 480l117.7-30.9c32.4 17.7 68.9 27 106.1 27h.1c122.3 0 224.1-99.6 224.1-222 0-59.3-25.2-115-67.1-157zm-157 341.6c-33.2 0-65.7-8.9-94-25.7l-6.7-4-69.8 18.3L72 359.2l-4.4-7c-18.5-29.4-28.2-63.3-28.2-98.2 0-101.7 82.8-184.5 184.6-184.5 49.3 0 95.6 19.2 130.4 54.1 34.8 34.9 56.2 81.2 56.1 130.5 0 101.8-84.9 184.6-186.6 184.6zm101.2-138.2c-5.5-2.8-32.8-16.2-37.9-18-5.1-1.9-8.8-2.8-12.5 2.8-3.7 5.6-14.3 18-17.6 21.8-3.2 3.7-6.5 4.2-12 1.4-32.6-16.3-54-29.1-75.5-66-5.7-9.8 5.7-9.1 16.3-30.3 1.8-3.7.9-6.9-.5-9.7-1.4-2.8-12.5-30.1-17.1-41.2-4.5-10.8-9.1-9.3-12.5-9.5-3.2-.2-6.9-.2-10.6-.2-3.7 0-9.7 1.4-14.8 6.9-5.1 5.6-19.4 19-19.4 46.3 0 27.3 19.9 53.7 22.6 57.4 2.8 3.7 39.1 59.7 94.8 83.8 35.2 15.2 49 16.5 66.6 13.9 10.7-1.6 32.8-13.4 37.4-26.4 4.6-13 4.6-24.1 3.2-26.4-1.3-2.5-5-3.9-10.5-6.6z"/></svg>`
    const globeIcon = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:-3px"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2c2.5 2.6 4 6.1 4 10s-1.5 7.4-4 10c-2.5-2.6-4-6.1-4-10s1.5-7.4 4-10z"/></svg>`

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${inv.invoice_number}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&family=Open+Sans:ital,wght@0,400;0,600;0,700;1,400;1,700&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family: 'Open Sans', ${FONT}; color: #222; background:#fff; font-size:13px; ${bgCss} }
    .disp { font-family: 'Poppins', 'Open Sans', ${FONT} }
    @page { margin: ${pageMargin}; size: A4 portrait }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact } }
  </style>
</head>
<body style="padding:${bodyPad};max-width:${bgStyle === 'shade' ? '210mm' : '800px'};margin:0 auto;position:relative">
  ${cornerSvg}${shadeSvg}
  <div style="position:relative;z-index:1;display:flex;flex-direction:column;min-height:${bgStyle === 'shade' ? '258mm' : '248mm'}">

  <!-- ── HEADER: logo | divider | tagline ..... INVOICE ── -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:4px">
    <tr>
      <td style="vertical-align:middle;width:62%">
        <div style="display:flex;align-items:center">
          ${logoBlock}
          ${showName ? `<div class="disp" style="font-size:24px;font-weight:800;color:#111;letter-spacing:-0.5px;margin-left:10px">${co.name}</div>` : ''}
          ${showTagline && tagWords[0] ? `
          <div style="width:1.5px;height:44px;background:#c4c4c4;margin:0 14px;flex-shrink:0"></div>
          <div class="disp" style="font-size:17.5px;line-height:1.3;color:#161616">
            ${tagWords.length > 1
              ? `<div style="font-weight:400">${tagWords.slice(0, -1).join(' ')}</div><div style="font-weight:700">${tagWords[tagWords.length - 1]}</div>`
              : `<div style="font-weight:600">${co.tagline}</div>`}
          </div>` : ''}
        </div>
      </td>
      <td style="vertical-align:top;text-align:right;width:38%;padding-top:4px">
        <div class="disp" style="display:inline-block;font-size:33px;font-weight:800;color:#0f0f0f;letter-spacing:0.5px;line-height:1;border-bottom:4px solid #0f0f0f;padding-bottom:5px">INVOICE</div>
      </td>
    </tr>
  </table>

  <!-- ── CONTACT + INVOICE META (left) · BILL TO (right) ── -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
    <tr>
      <td style="vertical-align:top;width:62%">
        ${showContact && (co.phone || co.website) ? `
        <div style="font-size:14px;font-weight:700;color:#111;margin-top:8px;letter-spacing:0.1px">
          ${co.phone ? `${waIcon}&nbsp; ${co.phone}` : ''}
          ${co.website ? `&nbsp;&nbsp;&nbsp;&nbsp;${globeIcon}&nbsp; ${co.website}` : ''}
        </div>` : ''}
        <table style="border-collapse:collapse;margin-top:22px">
          <tr>
            <td style="font-size:13.5px;font-weight:700;color:#111;padding:2.5px 0;white-space:nowrap">Invoice No.</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 0">${inv.invoice_number}</td>
          </tr>
          <tr>
            <td style="font-size:13.5px;font-weight:700;color:#111;padding:2.5px 0">Date</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:13.5px;color:#222;padding:2.5px 0">${dd(inv.issue_date)}</td>
          </tr>
          ${inv.billing_period_start ? `
          <tr>
            <td style="font-size:12.5px;font-weight:700;color:#111;padding:2.5px 0">Period</td>
            <td style="font-size:12.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:12.5px;color:#222;padding:2.5px 0">${formatBillingPeriod(inv.billing_period_start)}</td>
          </tr>` : ''}
          ${inv.due_date ? `
          <tr>
            <td style="font-size:12.5px;font-weight:700;color:#111;padding:2.5px 0">Due Date</td>
            <td style="font-size:12.5px;color:#222;padding:2.5px 12px">:</td>
            <td style="font-size:12.5px;font-weight:600;color:#b03030;padding:2.5px 0">${dd(inv.due_date)}</td>
          </tr>` : ''}
        </table>
      </td>
      <td style="vertical-align:top;width:38%;padding-top:10px">
        <div style="font-size:14.5px;color:#222">Bill to :</div>
        <div style="font-size:16px;font-weight:700;color:#111;margin-top:3px">${inv.client?.name || ''}</div>
        ${inv.client?.address ? `<div style="font-size:13px;color:#222;margin-top:2px;line-height:1.5">${inv.client.address}</div>` : ''}
        ${inv.client?.phone   ? `<div style="font-size:13px;color:#222;margin-top:2px">${inv.client.phone}</div>` : ''}
        ${inv.client?.email   ? `<div style="font-size:13px;color:#222">${inv.client.email}</div>` : ''}
      </td>
    </tr>
  </table>

  <!-- ── ITEMS TABLE ── -->
  <table style="width:100%;border-collapse:collapse;margin:14px 0 12px">
    <thead>
      <tr style="background:linear-gradient(180deg,${HEAD_TOP} 0%,${HEAD_BOT} 100%)">
        <th class="disp" style="padding:11px 8px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;width:46px">No.</th>
        <th class="disp" style="padding:11px 8px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;white-space:nowrap;width:118px">Date</th>
        <th class="disp" style="padding:11px 8px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff">Jobs Done</th>
        <th class="disp" style="padding:11px 8px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;width:54px">Qty</th>
        <th class="disp" style="padding:11px 8px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;white-space:nowrap;width:118px">Rate</th>
        <th class="disp" style="padding:11px 8px;text-align:center;color:#fff;font-size:13.5px;font-weight:700;border-left:2px solid #fff;white-space:nowrap;width:130px">Total Amount</th>
      </tr>
    </thead>
    <tbody>
      ${allItemRows || `<tr><td colspan="6" style="padding:20px;text-align:center;color:#999;font-size:12px">No items</td></tr>`}
    </tbody>
  </table>

  ${separateExpensesBlock}

  <!-- ── TOTALS (right block, reference style) ── -->
  <table style="width:100%;border-collapse:collapse;margin-top:6px">
    <tr>
      <td style="width:42%"></td>
      <td style="width:58%">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:5px 8px;font-size:13.5px;color:#222;text-align:right">Total Amount Due</td>
            <td style="padding:5px 6px;font-size:13.5px;color:#222;width:14px">:</td>
            <td style="padding:5px 0;font-size:13.5px;font-weight:700;color:#111;text-align:right;width:110px;white-space:nowrap">${inr(subtotal)}</td>
          </tr>
          ${discount > 0 ? `
          <tr>
            <td style="padding:5px 8px;font-size:13.5px;color:#222;text-align:right">Discount</td>
            <td style="padding:5px 6px;font-size:13.5px;color:#222">:</td>
            <td style="padding:5px 0;font-size:13.5px;font-weight:700;color:#1d9a52;text-align:right;white-space:nowrap">- ${inr(discount)}</td>
          </tr>` : ''}
          ${taxAmt > 0 ? `
          <tr>
            <td style="padding:5px 8px;font-size:13.5px;color:#222;text-align:right">Tax (${inv.tax_rate || 0}%)</td>
            <td style="padding:5px 6px;font-size:13.5px;color:#222">:</td>
            <td style="padding:5px 0;font-size:13.5px;font-weight:700;color:#111;text-align:right;white-space:nowrap">+ ${inr(taxAmt)}</td>
          </tr>` : ''}
          ${prevBal > 0 ? `
          <tr>
            <td style="padding:5px 8px;font-size:13.5px;color:#222;text-align:right">Previous Balance</td>
            <td style="padding:5px 6px;font-size:13.5px;color:#222">:</td>
            <td style="padding:5px 0;font-size:13.5px;font-weight:700;color:#111;text-align:right;white-space:nowrap">${inr(prevBal)}</td>
          </tr>` : ''}
          <tr>
            <td colspan="3" style="border-top:1.5px solid #9a9a9a;padding:0;height:4px"></td>
          </tr>
          <tr>
            <td class="disp" style="padding:6px 8px;font-size:15.5px;font-weight:700;color:#0f0f0f;text-align:right">Total Payable</td>
            <td class="disp" style="padding:6px 6px;font-size:15.5px;font-weight:700;color:#0f0f0f">:</td>
            <td class="disp" style="padding:6px 0;font-size:15.5px;font-weight:800;color:#0f0f0f;text-align:right;white-space:nowrap">${inr(totalPayable)}</td>
          </tr>
        </table>
        ${(inv.paid_amount || 0) > 0 ? `
        <table style="width:100%;border-collapse:collapse;margin-top:6px">
          <tr>
            <td style="padding:2px 8px;font-size:12px;font-style:italic;color:#1d9a52;text-align:right">Amount Received</td>
            <td style="padding:2px 6px;font-size:12px;color:#1d9a52;width:14px">:</td>
            <td style="padding:2px 0;font-size:12px;font-weight:700;color:#1d9a52;text-align:right;width:110px;white-space:nowrap">${inr(inv.paid_amount || 0)}</td>
          </tr>
          ${balanceDue(inv) > 0 ? `
          <tr>
            <td style="padding:2px 8px;font-size:12.5px;font-style:italic;font-weight:700;color:#c43c3c;text-align:right">Balance Due</td>
            <td style="padding:2px 6px;font-size:12.5px;color:#c43c3c">:</td>
            <td style="padding:2px 0;font-size:12.5px;font-weight:700;color:#c43c3c;text-align:right;white-space:nowrap">${inr(balanceDue(inv))}</td>
          </tr>` : ''}
        </table>` : ''}
      </td>
    </tr>
  </table>

  ${inv.notes ? `<div style="margin-top:14px;font-size:11.5px;color:#444;font-style:italic">${inv.notes}</div>` : ''}

  <!-- ── FOOTER: payment info | QR | thank-you (pinned to page bottom) ── -->
  <div style="margin-top:auto;padding-top:30px">
    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="vertical-align:bottom;width:46%">${paymentBlock}</td>
        <td style="vertical-align:bottom;text-align:center;width:23%">${qrBlock}</td>
        <td style="vertical-align:bottom;width:31%">
          <div style="display:flex;justify-content:flex-end">${thankBlock}</div>
        </td>
      </tr>
    </table>
  </div>

  </div>
  ${opts?.autoprint ? `<script>document.fonts.ready.then(function(){setTimeout(function(){window.print()},200)})</script>` : ''}
</body>
</html>`

    return html
  }

  function printInvoice(inv: Invoice) {
    const html = buildInvoiceHtml(inv, { autoprint: true })
    const w = window.open('', '_blank', 'width=800,height=900')
    if (w) { w.document.write(html); w.document.close() }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────
  function StatusBadge({ status }: { status: string }) {
    return (
      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${getStatusColor(status)}`}>
        {getStatusLabel(status)}
      </span>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEFT PANEL — Invoice List
  // ─────────────────────────────────────────────────────────────────────────
  function renderList() {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Search + filter bar */}
        <div className="px-3 py-2 border-b border-border/40 space-y-2">
          <TokenizedSearch
            facets={searchFacets}
            onFacetsChange={setSearchFacets}
            draft={searchDraft}
            onDraftChange={setSearchDraft}
            placeholder="Search invoice or client…"
            fields={[
              { key: 'number', label: 'Invoice #', type: 'text' },
              { key: 'client', label: 'Client', type: 'text' },
              { key: 'amount', label: 'Amount ₹', type: 'number' },
            ]}
          />
          <div className="flex gap-1.5 flex-wrap items-center justify-between w-full">
            <div className="flex gap-1.5 flex-wrap">
              {['', 'draft', 'reviewed', 'sent', 'partial', 'overdue'].map(s => (
                <button key={s}
                  onClick={() => setFilterStatus(s)}
                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${filterStatus === s ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}
                >{s ? getStatusLabel(s) : 'All'}</button>
              ))}
            </div>
            {filtered.length > 0 && (
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                <input
                  type="checkbox"
                  className="rounded border-border/40 bg-transparent text-violet-500 focus:ring-0 cursor-pointer h-3 w-3"
                  checked={filtered.length > 0 && filtered.every(i => selectedForBulk.has(i.id))}
                  onChange={toggleSelectAllBulk}
                />
                Select All
              </label>
            )}
          </div>

          {/* Tokenized active filters */}
          <ActiveFilterChips
            chips={[
              ...(filterStatus ? [{ key: 'status', label: 'Status', value: getStatusLabel(filterStatus), onRemove: () => setFilterStatus('') }] : []),
              ...(filterClient ? [{ key: 'client', label: 'Client', value: invoices.find(i => i.client_id === filterClient)?.client?.name || 'Selected', onRemove: () => setFilterClient('') }] : []),
            ]}
            onClearAll={() => { setFilterStatus(''); setFilterClient('') }}
          />
          
          {/* Bulk Action Bar */}
          {selectedForBulk.size > 0 && (
            <div className="flex items-center justify-between bg-violet-500/10 border border-violet-500/30 rounded-lg px-3 py-2 mt-2 animate-in slide-in-from-top-2">
              <span className="text-xs font-medium text-violet-300">{selectedForBulk.size} selected</span>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => handleBulkStatusUpdate('reviewed')}
                  disabled={isUpdatingBulk}
                  className="text-[10px] font-medium bg-background border border-border hover:bg-secondary px-2 py-1 rounded transition-colors disabled:opacity-50"
                >
                  Mark Reviewed
                </button>
                <button 
                  onClick={() => handleBulkStatusUpdate('sent')}
                  disabled={isUpdatingBulk}
                  className="text-[10px] font-medium bg-violet-500 text-white hover:bg-violet-600 px-2 py-1 rounded transition-colors disabled:opacity-50"
                >
                  Mark Sent
                </button>
                <button 
                  onClick={() => setSelectedForBulk(new Set())}
                  className="p-1 text-muted-foreground hover:text-foreground rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto divide-y divide-border/30">
          {filtered.length === 0 && (
            <div className="p-6 text-center text-muted-foreground text-sm">
              {tab === 'active' ? 'No active invoices' : 'No closed invoices'}
            </div>
          )}
          {filtered.map(inv => {
            const balance = balanceDue(inv)
            const overdue = isOverdue(inv.due_date || '', inv.status)
            const isSelected = selectedId === inv.id
            return (
              <div
                key={inv.id}
                onClick={() => selectInvoice(inv.id)}
                className="hover-gradient-row px-3 py-3"
              >
                <div className="flex items-start gap-3">
                  <div className="pt-1.5" onClick={e => e.stopPropagation()}>
                    <input 
                      type="checkbox" 
                      className="rounded border-border/40 bg-transparent text-violet-500 focus:ring-0 cursor-pointer h-3.5 w-3.5"
                      checked={selectedForBulk.has(inv.id)}
                      onChange={(e) => toggleBulkSelection(e as unknown as React.MouseEvent, inv.id)}
                    />
                  </div>
                  <div className="flex items-start justify-between gap-2 flex-1 min-w-0">
                    <div className="min-w-0 flex-1 flex flex-col items-start gap-0.5">
                      <div className="flex items-center gap-1.5 mb-0.5">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); copyInvNum(inv.invoice_number) }}
                        title="Copy invoice number"
                        className="flex items-center gap-0.5 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors group/copy"
                      >
                        {inv.invoice_number}
                        <Copy className="w-2.5 h-2.5 ml-0.5 lg:opacity-0 opacity-50 group-hover/copy:opacity-50 transition-opacity" />
                      </button>
                      <StatusBadge status={overdue && inv.status !== 'paid' ? 'overdue' : inv.status} />
                    </div>
                    <div className="text-sm font-medium text-foreground truncate">{inv.client?.name || '—'}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">
                        {inv.billing_period_start ? formatBillingPeriod(inv.billing_period_start) : fmtDate(inv.issue_date)}
                      </span>
                      {(inv.items?.length || 0) > 0 && (
                        <span className="text-[10px] text-muted-foreground">{inv.items!.length} task{inv.items!.length !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <div className={`text-sm font-semibold ${balance > 0 && overdue ? 'text-red-400' : 'text-foreground'}`}>
                      {fmt(inv.total_amount, inv.currency)}
                    </div>
                    {(inv.paid_amount ?? 0) > 0 && inv.status !== 'paid' && (
                      <div className="text-[10px] text-green-400">
                        Paid {fmt(inv.paid_amount, inv.currency)}
                      </div>
                    )}
                    {role === 'super_admin' && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); setEditClientId(inv.client_id) }}
                        title={`Edit ${inv.client?.name}`}
                        className="text-muted-foreground/30 hover:text-violet-400 transition-colors"
                      >
                        <ExternalLink size={10} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Invoice Detail
  // ─────────────────────────────────────────────────────────────────────────
  function renderDetail(inv: Invoice) {
    const forceEdit = forceEditId === inv.id
    const editable = isEditable(inv.status) || forceEdit
    const balance = balanceDue(inv)
    const overdue = isOverdue(inv.due_date || '', inv.status)
    const nextAct = getNextAction(inv.status)
    const periodLabel = inv.billing_period_start ? formatBillingPeriod(inv.billing_period_start) : null

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/40 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <button
                type="button"
                onClick={() => copyInvNum(inv.invoice_number)}
                title="Copy invoice number"
                className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors group"
              >
                <span>{inv.invoice_number}</span>
                <Copy className={`w-3 h-3 shrink-0 transition-colors ${copiedInvNum ? 'text-green-400' : 'lg:opacity-0 opacity-60 group-hover:opacity-60'}`} />
              </button>
              <StatusBadge status={overdue && inv.status !== 'paid' ? 'overdue' : inv.status} />
              {editable && (
                <span className="text-[9px] text-amber-400/80 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-full">Editable</span>
              )}
            </div>
            <h3 className="font-semibold text-foreground">{inv.client?.name}</h3>
            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
              {periodLabel && <span><Calendar className="inline w-3 h-3 mr-0.5" />{periodLabel}</span>}
              <span>Issued {fmtDate(inv.issue_date)}</span>
              {inv.due_date && <span className={overdue ? 'text-red-400' : ''}>Due {fmtDate(inv.due_date)}</span>}
            </div>
          </div>
          <div className="flex gap-1.5 items-start shrink-0">
            <button onClick={() => refreshInvoice(inv.id)} title="Refresh"
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded-lg transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setPreviewInv(inv)} title="Preview invoice"
              className="p-1.5 text-muted-foreground hover:text-violet-400 hover:bg-violet-500/10 rounded-lg transition-colors">
              <Eye className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => printInvoice(inv)} title="Print"
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded-lg transition-colors">
              <Printer className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => {
                const text = [
                  `📄 Invoice ${inv.invoice_number}`,
                  `Client: ${inv.client?.name || ''}`,
                  showAmounts ? `Amount: ${fmt(inv.total_amount, inv.currency)}` : '',
                  inv.due_date ? `Due: ${fmtDate(inv.due_date)}` : '',
                  `\nhttps://app.cirqle.work/dashboard/invoices`,
                ].filter(Boolean).join('\n')
                window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank')
              }}
              title="Share via WhatsApp"
              className="p-1.5 text-muted-foreground hover:text-green-400 hover:bg-green-500/10 rounded-lg transition-colors">
              <Share2 className="w-3.5 h-3.5" />
            </button>
            {/* Force-edit toggle — requires reason before unlocking */}
            {!isEditable(inv.status) && (
              <button
                onClick={() => forceEdit ? lockEdit() : requestEditUnlock(inv.id)}
                title={forceEdit ? 'Lock editing' : 'Force edit (requires reason)'}
                className={`p-1.5 rounded-lg transition-colors ${forceEdit ? 'text-amber-400 bg-amber-500/20' : 'text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10'}`}>
                {forceEdit ? <Lock className="w-3.5 h-3.5" /> : <Edit2 className="w-3.5 h-3.5" />}
              </button>
            )}
            <button onClick={() => confirmDelete(inv.id)} title="Delete"
              className="p-1.5 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

          {/* Action pipeline */}
          <div className="bg-foreground/[0.03] rounded-xl border border-border/40 p-3">
            <div className="flex items-center gap-1 mb-3">
              {STATUS_PIPELINE.map((s, idx) => {
                const pos = STATUS_PIPELINE.indexOf(inv.status)
                const isPast = idx < pos
                const isCurrent = s === inv.status
                return (
                  <div key={s} className="flex items-center flex-1 min-w-0">
                    <div className={`text-center flex-1 min-w-0 ${isCurrent ? 'text-violet-400' : isPast ? 'text-green-400' : 'text-muted-foreground/40'}`}>
                      <div className={`mx-auto w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold mb-0.5
                        ${isCurrent ? 'bg-violet-500/20 border border-violet-500' : isPast ? 'bg-green-500/20 border border-green-500' : 'bg-foreground/5 border border-border/40'}`}>
                        {isPast ? '✓' : idx + 1}
                      </div>
                      <div className="text-[9px] truncate">{getStatusLabel(s)}</div>
                    </div>
                    {idx < STATUS_PIPELINE.length - 1 && (
                      <div className={`h-px flex-shrink-0 w-3 mx-0.5 ${idx < pos ? 'bg-green-500/40' : 'bg-border/40'}`} />
                    )}
                  </div>
                )
              })}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              {nextAct && (
                <button
                  onClick={() => updateStatus(inv.id, nextAct.next)}
                  disabled={saving}
                  className="flex-1 min-w-[120px] py-1.5 px-3 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50">
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
                  disabled={hasActiveAllocations(inv)}
                  title={hasActiveAllocations(inv) ? 'Paid via cashbook allocation — manage it there' : undefined}
                  className="flex-1 min-w-[120px] py-1.5 px-3 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-green-600 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors">
                  <CreditCard className="w-3.5 h-3.5" />Record Payment
                </button>
              )}
              {inv.status === 'draft' && (
                <button
                  onClick={() => openPayPanel(inv)}
                  disabled={hasActiveAllocations(inv)}
                  title={hasActiveAllocations(inv) ? 'Paid via cashbook allocation — manage it there' : undefined}
                  className="flex-1 min-w-[120px] py-1.5 px-3 bg-foreground/[0.06] hover:bg-foreground/[0.1] disabled:opacity-40 disabled:cursor-not-allowed text-foreground text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors border border-border/40">
                  <CreditCard className="w-3.5 h-3.5" />Quick Pay
                </button>
              )}
              {/* Allocate From Cash Book — alternate entry point into the same
                  allocation engine. Shown when the invoice still has a balance
                  and isn't already taking a direct "Record Payment" (mutual
                  exclusion). Allocating MORE on top of existing allocations is
                  allowed (multiple payments against one invoice). */}
              {showAmounts
                && !STATUS_GROUPS.closed.includes(inv.status)
                && balanceDueInr(inv) > 0.01
                && (inv.payments || []).length === 0 && (
                <button
                  onClick={() => setAllocatingInvoice(inv)}
                  className="flex-1 min-w-[120px] py-1.5 px-3 bg-violet-600/10 hover:bg-violet-600/20 text-violet-300 border border-violet-500/30 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors">
                  <Wallet className="w-3.5 h-3.5" />Allocate From Cash Book
                </button>
              )}
              {!STATUS_GROUPS.closed.includes(inv.status) && (
                <button
                  onClick={() => setAddExpenseInvoice(inv)}
                  className="flex-1 min-w-[120px] py-1.5 px-3 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors">
                  <ShoppingBag className="w-3.5 h-3.5" />Add Expenses
                </button>
              )}
            </div>
            {hasActiveAllocations(inv) && (
              <p className="px-1 pt-2 text-[11px] text-amber-500/90">
                Paid via cashbook allocation — record or adjust payment from the cashbook entry, not here.
              </p>
            )}

            {/* Status override dropdown */}
            <details className="mt-2">
              <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground list-none flex items-center gap-1">
                <MoreHorizontal className="w-3 h-3" /> More status options
              </summary>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {['draft', 'reviewed', 'sent', 'partial', 'paid', 'overdue', 'cancelled', 'bad_debt'].map(s => (
                  <button key={s} onClick={() => updateStatus(inv.id, s)}
                    disabled={saving || inv.status === s}
                    className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors disabled:opacity-30
                      ${inv.status === s ? getStatusColor(s) : 'border-border/40 text-muted-foreground hover:border-violet-500/50 hover:text-violet-400'}`}>
                    {getStatusLabel(s)}
                  </button>
                ))}
              </div>
            </details>
          </div>

          {/* Amounts */}
          <div className="bg-foreground/[0.03] rounded-xl border border-border/40 p-3 space-y-2">
            {/* Currency selector — only on editable drafts (no payments yet) */}
            {editable && invPaidInr(inv) === 0 && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Invoice currency</span>
                <select
                  value={inv.currency}
                  onChange={e => updateInvoiceCurrency(inv.id, e.target.value as Currency)}
                  className="bg-background border border-border/40 rounded px-2 py-0.5 text-xs font-mono focus:outline-none focus:border-violet-500/50">
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-medium">{fmt(inv.subtotal || inv.total_amount, inv.currency)}</span>
            </div>

            {/* Tax rate — only show if GST is enabled in settings OR already set on invoice */}
            {(companySettings.gst_enabled === 'true' || (inv.tax_rate || 0) > 0) && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">GST / Tax</span>
                {editable ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="number" min="0" max="100" step="0.5"
                      key={`tax-${inv.id}-${inv.tax_rate}`}
                      defaultValue={inv.tax_rate || 0}
                      onBlur={e => updateTaxRate(inv.id, parseFloat(e.target.value) || 0)}
                      className="w-12 bg-background border border-border/40 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:border-violet-500/50"
                    />
                    <span className="text-muted-foreground text-xs">%</span>
                    <span className="text-xs">= {fmt(inv.tax_amount || 0, inv.currency)}</span>
                  </div>
                ) : (
                  <span>{inv.tax_rate || 0}% = {fmt(inv.tax_amount || 0, inv.currency)}</span>
                )}
              </div>
            )}

            {/* Discount — show if editable or if discount already applied */}
            {(editable || (inv.discount_amount || 0) > 0) && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Discount</span>
                {editable ? (
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground text-xs">−{getCurrencySymbol(inv.currency)}</span>
                    <input
                      type="number" min="0"
                      key={`disc-${inv.id}-${inv.discount_amount}`}
                      defaultValue={inv.discount_amount || 0}
                      onBlur={e => updateDiscount(inv.id, parseFloat(e.target.value) || 0)}
                      className="w-20 bg-background border border-border/40 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:border-violet-500/50"
                    />
                  </div>
                ) : (
                  <span className="text-orange-400 font-medium">−{fmt(inv.discount_amount || 0, inv.currency)}</span>
                )}
              </div>
            )}

            {/* Previous Balance — editable if draft/reviewed */}
            <div className="flex justify-between items-center text-sm">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-red-400/80">Prev. Balance</span>
                {editable && (
                  <button
                    onClick={() => autoLoadPrevBalance(inv.id, inv.client_id)}
                    title="Auto-fill from pending invoices of this client"
                    className="p-0.5 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors">
                    <ArrowDownToLine className="w-3 h-3" />
                  </button>
                )}
              </div>
              {editable ? (
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-xs text-red-400/70">+{getCurrencySymbol(inv.currency)}</span>
                  <input
                    type="number" min="0"
                    key={`prevbal-${inv.id}-${inv.previous_balance}`}
                    defaultValue={inv.previous_balance || 0}
                    onBlur={e => updatePreviousBalance(inv.id, parseFloat(e.target.value) || 0)}
                    className="w-20 bg-background border border-border/40 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:border-red-500/50 text-red-400"
                  />
                </div>
              ) : (
                <span className={(inv.previous_balance ?? 0) > 0 ? 'text-red-400' : 'text-muted-foreground'}>
                  {(inv.previous_balance ?? 0) > 0 ? `+${fmt(inv.previous_balance, inv.currency)}` : '—'}
                </span>
              )}
            </div>

            <div className="border-t border-border/40 pt-2 flex justify-between">
              <span className="font-semibold">Total</span>
              <span className="font-bold text-base">{fmt(inv.total_amount, inv.currency)}</span>
            </div>

            {/* Exchange rate — manual override for foreign invoices. The auto-fetched
                Settings rate is the default; correct it to the rate actually billed.
                total_amount_inr (the ₹ booked value) recomputes from it. */}
            {inv.currency !== 'INR' && showAmounts && (
              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">Exchange rate</span>
                {/* Editable only while unsettled — once cash is allocated the rate is
                    effectively locked by the settlement (use Settle-in-full to change it). */}
                {!['paid', 'cancelled', 'bad_debt'].includes(inv.status) && invPaidInr(inv) === 0 ? (
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground text-xs">1 {inv.currency} = ₹</span>
                    <input
                      type="number" min="0" step="0.0001"
                      key={`rate-${inv.id}-${inv.exchange_rate}`}
                      defaultValue={inv.exchange_rate || ''}
                      onBlur={e => { const v = parseFloat(e.target.value); if (v > 0 && v !== inv.exchange_rate) updateExchangeRate(inv.id, v) }}
                      className="w-24 bg-background border border-border/40 rounded px-1.5 py-0.5 text-xs text-right font-mono focus:outline-none focus:border-violet-500/50"
                    />
                    {(rateMap[inv.currency] || 0) > 0 && Math.abs((inv.exchange_rate || 0) - rateMap[inv.currency]) > 0.0001 && (
                      <button
                        onClick={() => updateExchangeRate(inv.id, rateMap[inv.currency])}
                        title={`Reset to Settings rate ₹${rateMap[inv.currency]}`}
                        className="p-0.5 text-violet-400/70 hover:text-violet-300 hover:bg-violet-500/10 rounded transition-colors">
                        <RefreshCw className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="font-mono text-xs">1 {inv.currency} = ₹{(inv.exchange_rate || 1).toLocaleString('en-IN')}</span>
                )}
              </div>
            )}
            {inv.currency !== 'INR' && showAmounts && (
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>Value in ₹ (booked)</span>
                <span className="font-mono">₹{(inv.total_amount_inr ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              </div>
            )}
            {(inv.paid_amount ?? 0) > 0 && (
              <>
                <div className="flex justify-between text-sm text-green-400">
                  <span>Paid</span>
                  <span>{fmt(inv.paid_amount, inv.currency)}</span>
                </div>
                <div className={`flex justify-between text-sm font-semibold ${balance > 0 ? 'text-orange-400' : 'text-green-400'}`}>
                  <span>Balance Due</span>
                  <span>{fmt(balance, inv.currency)}</span>
                </div>
              </>
            )}
          </div>

          {/* Linked Cash Book payments — the allocation relationship. Lets the
              user see which cashbook entries pay this invoice, how much, and
              jump straight to the entry. */}
          {(() => {
            const links = (inv.cashbook_invoice_allocations || []).filter(a => !a.deleted_at && a.cashbook_entry)
            if (links.length === 0) return null
            return (
              <div className="bg-violet-500/[0.04] rounded-xl border border-violet-500/20 p-3 space-y-2">
                <h4 className="text-[11px] font-semibold text-violet-300/90 uppercase tracking-wider flex items-center gap-1.5">
                  <Link2 className="w-3 h-3" />Cash Book Payments ({links.length})
                </h4>
                {links.map(a => (
                  <div key={a.id} className="flex items-center justify-between gap-3 text-xs">
                    <a
                      href={`/dashboard/cashbook?client=${inv.client_id}&focus=${a.cashbook_entry!.id}`}
                      className="group inline-flex items-center gap-1.5 text-foreground/90 hover:text-violet-300 transition-colors min-w-0">
                      <span className="font-mono truncate">
                        {a.cashbook_entry!.reference || a.cashbook_entry!.entry_date || 'Entry'}
                      </span>
                      <ExternalLink className="w-3 h-3 shrink-0 opacity-50 group-hover:opacity-100" />
                    </a>
                    {showAmounts && (
                      <span className="font-mono font-semibold text-green-400 shrink-0">
                        ₹{Number(a.allocated_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}

          {/* Client Expenses section — hidden here, expenses now shown inline in LINE ITEMS above */}
          {false && (inv.expense_items || []).length > 0 && (() => {
            const expMode = inv.expenses_mode || companySettings.expense_display_mode || 'mode_a'
            const expTotal = (inv.expense_items || []).reduce((s, e) => s + (e.amount || 0), 0)
            const origTotal = (inv.expense_items || []).reduce((s, e) => s + (e.original_amount || e.amount || 0), 0)
            const markupTotal = (inv.expense_items || []).reduce((s, e) => s + (e.markup_amount || 0), 0)
            return (
              <div className="bg-amber-500/[0.04] rounded-xl border border-amber-500/20 p-3 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-1">
                  <h4 className="text-[11px] font-semibold text-amber-300/90 uppercase tracking-wider flex items-center gap-1.5">
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
                            ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
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
                          <span className="font-mono text-amber-300/90 shrink-0 font-semibold">
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
                        <div className="flex justify-between text-[10px] text-amber-300/70">
                          <span>Markup earned</span>
                          <span className="font-mono">+{fmt(markupTotal, inv.currency)}</span>
                        </div>
                      </>
                    )}
                    <div className="flex justify-between text-[11px] text-amber-300/90 font-semibold">
                      <span>Billed to client</span>
                      <span className="font-mono">{fmt(expTotal, inv.currency)}</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Line Items ({(inv.items?.length || 0) + (inv.expense_items?.length || 0)})
              </h4>
              <div className="flex items-center gap-2">
                {forceEdit && (
                  <span className="text-[9px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded-full">
                    ✏️ Force edit on
                  </span>
                )}
                {!forceEdit && isEditable(inv.status) && (
                  <span className="text-[10px] text-amber-400/70">
                    <Zap className="inline w-2.5 h-2.5 mr-0.5" />Auto-collecting
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-1">
              {(inv.items || []).length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-4 bg-foreground/[0.02] rounded-lg border border-dashed border-border/40">
                  No items yet — tasks marked "done" auto-appear here
                </div>
              )}
              {(inv.items || []).sort((a, b) => a.display_order - b.display_order).map(item => (
                <div key={item.id} className="flex items-start gap-2 p-2 bg-foreground/[0.02] rounded-lg border border-border/30 hover:border-border/60 transition-colors group">
                  <div className="flex-1 min-w-0">
                    {editable ? (
                      <input
                        defaultValue={item.description}
                        onBlur={e => { if (e.target.value !== item.description) updateItemDescription(item.id, inv.id, e.target.value) }}
                        className="w-full bg-transparent text-xs font-medium border-b border-transparent hover:border-border/40 focus:border-violet-500/50 focus:outline-none pb-0.5"
                        placeholder="Description…"
                      />
                    ) : (
                      <div className="text-xs font-medium truncate">{item.description}</div>
                    )}
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                      {item.task?.task_date && <span>{fmtDate(item.task.task_date)}</span>}
                      {item.service?.name && <span>{item.service.name}</span>}
                      {item.task && (
                        <span className={`px-1 py-0.5 rounded-full ${getStatusColor(item.task.status)}`}>
                          {getStatusLabel(item.task.status)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {editable ? (
                      <input
                        type="number" min="0"
                        defaultValue={item.unit_price}
                        onBlur={e => { const v = parseFloat(e.target.value); if (v !== item.unit_price) updateItemPrice(item.id, inv.id, v) }}
                        className="w-20 bg-background border border-border/40 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:border-violet-500/50"
                      />
                    ) : (
                      <div className="text-xs font-medium">{fmt(item.total, inv.currency)}</div>
                    )}
                    {item.quantity !== 1 && (
                      <div className="text-[10px] text-muted-foreground">{item.quantity} × {fmt(item.unit_price, inv.currency)}</div>
                    )}
                  </div>
                  {editable && (
                    <button
                      onClick={e => { e.stopPropagation(); removeItem(inv.id, item.id) }}
                      disabled={removingItemId === item.id}
                      className="lg:opacity-0 opacity-100 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-red-400 transition-all">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}

              {/* Expense items inline in line items */}
              {(inv.expense_items || []).map(exp => (
                <div key={`exp-${exp.id}`} className="flex items-start gap-2 p-2 bg-amber-500/[0.04] rounded-lg border border-amber-500/20 hover:border-amber-500/30 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <ShoppingBag className="w-2.5 h-2.5 text-amber-400/70 shrink-0" />
                      <div className="text-xs font-medium truncate">{exp.description}</div>
                    </div>
                    {exp.markup_type !== 'none' && (exp.markup_amount || 0) > 0 && showAmounts && (
                      <div className="text-[10px] text-muted-foreground mt-0.5 ml-4">
                        Cost {fmt(exp.original_amount || 0, exp.currency as Currency)} + markup {fmt(exp.markup_amount || 0, exp.currency as Currency)}
                      </div>
                    )}
                    {exp.notes && <div className="text-[10px] text-muted-foreground/60 italic mt-0.5 ml-4">{exp.notes}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    {showAmounts && <div className="text-xs font-medium text-amber-300/90">{fmt(exp.amount, inv.currency as Currency)}</div>}
                  </div>
                  {editable && (
                    <button
                      onClick={async () => {
                        const { error } = await supabase.from('invoice_expense_items').delete().eq('id', exp.id)
                        if (!error) {
                          const newExps = (inv.expense_items || []).filter(e => e.id !== exp.id)
                          const newExpTotal = newExps.reduce((s, e) => s + (e.amount || 0), 0)
                          const taskTotal = (inv.items || []).reduce((s, i) => s + (i.total || 0), 0)
                          const newTotal = round2(taskTotal + newExpTotal - (inv.discount_amount || 0) + (inv.tax_amount || 0))
                          await supabase.from('invoices').update({ total_amount: newTotal, subtotal: round2(taskTotal + newExpTotal) }).eq('id', inv.id)
                          setInvoices(prev => prev.map(i => i.id === inv.id
                            ? { ...i, expense_items: newExps, total_amount: newTotal, total_amount_inr: round2(newTotal * (i.exchange_rate || 1)), subtotal: round2(taskTotal + newExpTotal) }
                            : i
                          ))
                        }
                      }}
                      className="lg:opacity-0 opacity-100 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-red-400 transition-all shrink-0 mt-0.5"
                      title="Remove expense from invoice"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}

              {/* Add manual item row */}
              {editable && (() => {
                let addDesc = '', addPrice = 0
                return (
                  <div className="flex gap-2 items-center pt-1 border-t border-border/20 mt-1">
                    <input
                      placeholder="+ Add item description…"
                      onChange={e => { addDesc = e.target.value }}
                      className="flex-1 bg-transparent text-xs border-b border-dashed border-border/40 focus:border-violet-500/50 focus:outline-none py-1 placeholder:text-muted-foreground/40"
                    />
                    <input
                      type="number" min="0" placeholder={getCurrencySymbol(inv.currency)}
                      onChange={e => { addPrice = parseFloat(e.target.value) || 0 }}
                      className="w-16 bg-background border border-border/40 rounded px-1.5 py-1 text-xs text-right focus:outline-none focus:border-violet-500/50"
                    />
                    <button
                      onClick={() => addManualItem(inv.id, addDesc, addPrice)}
                      className="p-1 text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 rounded transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })()}
            </div>
          </div>

          {/* ── Discount Calculator ─────────────────────────────────────────────── */}
          {(editable || (inv.discount_amount ?? 0) > 0) && (
            <div className="bg-foreground/[0.03] rounded-xl border border-border/40 overflow-hidden">
              <button
                onClick={() => {
                  if (!showDiscount) { setShowDiscount(true); loadDiscountCalc(inv.client_id, inv.id) }
                  else setShowDiscount(false)
                }}
                className="w-full px-3 py-2.5 flex items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors">
                <span className="flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5 text-orange-400" />
                  Discount Calculator
                  {(inv.discount_amount ?? 0) > 0 && (
                    <span className="text-orange-400 font-medium">({fmt(inv.discount_amount, inv.currency)} applied)</span>
                  )}
                </span>
                {showDiscount ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showDiscount && (
                <div className="px-3 pb-3 space-y-3 border-t border-border/30">
                  {discountLoading ? (
                    <div className="py-4 text-center text-xs text-muted-foreground">Analysing client history…</div>
                  ) : discountCalc ? (
                    <>
                      {/* Client stats */}
                      <div className="grid grid-cols-3 gap-2 pt-2">
                        <div className="bg-foreground/[0.03] rounded-lg p-2 text-center">
                          <div className="text-[10px] text-muted-foreground">Total Billed</div>
                          <div className="text-xs font-semibold">{fmt(discountCalc.totalBilled)}</div>
                        </div>
                        <div className="bg-foreground/[0.03] rounded-lg p-2 text-center">
                          <div className="text-[10px] text-muted-foreground">Payment Rate</div>
                          <div className={`text-xs font-semibold ${discountCalc.paymentRate >= 0.95 ? 'text-green-400' : discountCalc.paymentRate >= 0.8 ? 'text-amber-400' : 'text-red-400'}`}>
                            {(discountCalc.paymentRate * 100).toFixed(0)}%
                          </div>
                        </div>
                        <div className="bg-foreground/[0.03] rounded-lg p-2 text-center">
                          <div className="text-[10px] text-muted-foreground">Invoices</div>
                          <div className="text-xs font-semibold">{discountCalc.invoiceCount}</div>
                        </div>
                      </div>

                      {/* Suggestion */}
                      <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg p-2.5">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] text-orange-400/80 font-semibold uppercase tracking-wider flex items-center gap-1">
                            <Gift className="w-3 h-3" />Suggested Max Discount
                          </span>
                          <span className="text-xs font-bold text-orange-400">{discountCalc.maxPct.toFixed(1)}%</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-muted-foreground">Up to</span>
                          <span className="text-sm font-bold text-orange-300">{fmt(discountCalc.suggestedMax, inv.currency)}</span>
                        </div>
                        {discountCalc.totalDiscGiven > 0 && (
                          <div className="text-[10px] text-muted-foreground mt-1">
                            Previously given: {fmt(discountCalc.totalDiscGiven)} across {discountCalc.discHistory.length} invoice(s)
                          </div>
                        )}
                      </div>

                      {/* Manual apply */}
                      {editable && (
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <div className="flex-1">
                              <label className="text-[10px] text-muted-foreground mb-1 block">Discount Amount ({getCurrencySymbol(inv.currency)})</label>
                              <input
                                type="number" min="0" max={discountCalc.thisTotal}
                                value={manualDiscount}
                                onChange={e => setManualDiscount(e.target.value)}
                                placeholder={`Max ${fmt(discountCalc.suggestedMax, inv.currency)}`}
                                className="w-full bg-background border border-border/40 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-orange-500/50"
                              />
                            </div>
                            <div className="text-center pt-4 text-[10px] text-muted-foreground">
                              {manualDiscount && discountCalc.thisTotal > 0
                                ? `${((parseFloat(manualDiscount) / discountCalc.thisTotal) * 100).toFixed(1)}%`
                                : '—'}
                            </div>
                          </div>
                          <div>
                            <label className="text-[10px] text-muted-foreground mb-1 block">Reason (optional)</label>
                            <input
                              type="text"
                              value={discountReason}
                              onChange={e => setDiscountReason(e.target.value)}
                              placeholder="e.g. Loyalty discount, early payment…"
                              className="w-full bg-background border border-border/40 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-orange-500/50"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setManualDiscount(discountCalc.suggestedMax.toFixed(2))}
                              className="flex-1 py-1.5 text-[10px] border border-orange-500/30 text-orange-400 rounded-lg hover:bg-orange-500/10 transition-colors">
                              Use Max ({fmt(discountCalc.suggestedMax, inv.currency)})
                            </button>
                            <button
                              onClick={() => applyDiscount(inv.id, inv.client_id)}
                              disabled={!manualDiscount}
                              className="flex-1 py-1.5 text-[10px] bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white rounded-lg transition-colors">
                              Apply Discount
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Discount history */}
                      {discountCalc.discHistory.length > 0 && (
                        <div>
                          <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-1.5">Discount History</div>
                          <div className="space-y-1 max-h-28 overflow-y-auto">
                            {discountCalc.discHistory.slice(0, 5).map((d: any, i: number) => (
                              <div key={i} className="flex items-center justify-between text-[10px] p-1.5 bg-foreground/[0.02] rounded border border-border/20">
                                <span className="text-muted-foreground truncate flex-1 mr-2">{d.reason}</span>
                                <span className="text-orange-400 font-semibold shrink-0">{fmt(d.discount_amount || 0)}</span>
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
          <div className="bg-foreground/[0.03] rounded-xl border border-border/40 overflow-hidden">
            <button
              onClick={() => {
                if (!showChangeLogs) loadChangeLogs(inv.id)
                else setShowChangeLogs(false)
              }}
              className="w-full px-3 py-2.5 flex items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors">
              <span className="flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-blue-400" />Edit History
              </span>
              {showChangeLogs ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {showChangeLogs && (
              <div className="px-3 pb-3 border-t border-border/30">
                {changeLogsLoading ? (
                  <div className="py-4 text-center text-xs text-muted-foreground">Loading…</div>
                ) : changeLogs.length === 0 ? (
                  <div className="py-4 text-center text-xs text-muted-foreground">No edits recorded yet</div>
                ) : (
                  <div className="space-y-1 pt-2 max-h-52 overflow-y-auto">
                    {changeLogs.map((log: any) => (
                      <div key={log.id} className="p-2 bg-foreground/[0.02] rounded-lg border border-border/20 text-[10px]">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="text-blue-400 font-semibold capitalize">{log.field_name.replace(/_/g, ' ')}</span>
                          <span className="text-muted-foreground">
                            {new Date(log.changed_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="line-through opacity-60">{log.old_value || '—'}</span>
                          <ChevronRight className="w-2.5 h-2.5 shrink-0" />
                          <span className="text-foreground font-medium">{log.new_value || '—'}</span>
                        </div>
                        <div className="mt-0.5 text-muted-foreground/60 italic">{log.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Payment history */}
          {(inv.payments || []).length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Payments ({inv.payments!.length})
              </h4>
              <div className="space-y-1">
                {inv.payments!.map(p => (
                  <div key={p.id} className="flex items-center justify-between p-2 bg-green-500/5 rounded-lg border border-green-500/20 text-xs">
                    <div>
                      <div className="font-medium text-green-400">{fmt(p.amount, (p.currency as Currency) || inv.currency)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {fmtDate(p.payment_date)} · {METHOD_LABEL[p.payment_method] || p.payment_method}
                        {p.reference && ` · ${p.reference}`}
                        {p.currency && p.currency !== 'INR' && p.amount_inr != null && (
                          <span> · @ {p.exchange_rate} = {fmt(p.amount_inr, 'INR')}</span>
                        )}
                      </div>
                    </div>
                    <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {inv.notes && (
            <div className="text-xs text-muted-foreground bg-foreground/[0.02] rounded-lg p-3 border border-border/30">
              {inv.notes}
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
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm">Record Payment</h3>
            <div className="text-xs text-muted-foreground">{inv.invoice_number} · Balance {fmt(balance, inv.currency)}</div>
          </div>
          <button onClick={() => setPanelMode('detail')} className="p-1.5 hover:bg-foreground/5 rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* Amount + currency + rate (3-way synced) */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Amount</label>
            {balance > 0 && (
              <div className="flex gap-2 mb-2 flex-wrap">
                {[balance, balance / 2].filter(v => v > 0).map((v, i) => (
                  <button key={i}
                    onClick={() => setPayForm(p => {
                      const fx = payFx(v.toFixed(2), p.currency, p.rate)
                      return { ...p, amount: v.toFixed(2), rate: fx.rate, amountInr: fx.amountInr, rateSource: fx.rateSource }
                    })}
                    className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${parseFloat(payForm.amount) === v ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}>
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
              <p className="mt-1.5 text-[11px] text-amber-400">
                Paying in {payForm.currency} on a {inv.currency} invoice — the balance is reduced by the ₹ value converted at the invoice rate.
              </p>
            )}
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Date</label>
            <input type="date" value={payForm.payment_date}
              onChange={e => setPayForm(p => ({ ...p, payment_date: e.target.value }))}
              className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Method</label>
            <div className="flex flex-wrap gap-1.5">
              {PAYMENT_METHODS.map(m => (
                <button key={m}
                  onClick={() => setPayForm(p => ({ ...p, payment_method: m }))}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${payForm.payment_method === m ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}>
                  {METHOD_LABEL[m]}
                </button>
              ))}
            </div>
          </div>

          {bankAccounts.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Bank Account (optional)</label>
              <AppSelect value={payForm.bank_account_id}
                onChange={e => setPayForm(p => ({ ...p, bank_account_id: e.target.value }))}>
                <option value="">— none —</option>
                {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </AppSelect>
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Reference (optional)</label>
            <input type="text" value={payForm.reference}
              onChange={e => setPayForm(p => ({ ...p, reference: e.target.value }))}
              placeholder="Txn ID / cheque number…"
              className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Notes (optional)</label>
            <input type="text" value={payForm.notes}
              onChange={e => setPayForm(p => ({ ...p, notes: e.target.value }))}
              placeholder="Any notes about this payment…"
              className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
            />
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
              <div className={`flex items-center justify-between px-3 py-2.5 rounded-xl border text-xs font-medium transition-colors ${
                after <= 0
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-blue-500/10 border-blue-500/30 text-blue-400'
              }`}>
                <span>{after <= 0 ? '✓ Fully paid' : 'Remaining after payment'}</span>
                <span className="font-semibold tabular-nums">
                  {after <= 0 ? fmt(0, inv.currency) : fmt(after, inv.currency)}
                </span>
              </div>
            )
          })()}

          {/* Advance payment toggle */}
          <div className={`flex items-start gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${isAdvancePayment ? 'bg-amber-500/10 border-amber-500/30' : 'bg-foreground/[0.02] border-border/40 hover:border-border/60'}`}
            onClick={() => setIsAdvancePayment(p => !p)}>
            <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${isAdvancePayment ? 'bg-amber-500 border-amber-500' : 'border-border/60'}`}>
              {isAdvancePayment && <span className="text-[10px] text-white font-bold">✓</span>}
            </div>
            <div>
              <div className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Tag className="w-3 h-3 text-amber-400" />Advance / Excess Payment
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                Mark this as an advance or accidental excess payment. It will be noted in payment records for future adjustment.
              </div>
              {isAdvancePayment && (
                <div className="mt-2 text-[10px] bg-amber-500/20 text-amber-300 px-2 py-1 rounded">
                  ⚠️ This amount exceeds the balance due and will be recorded as advance credit
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => handlePayment(inv.id)}
            disabled={saving || !payForm.amount}
            className="w-full py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors">
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
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm">Manual Invoice</h3>
            <p className="text-[11px] text-muted-foreground">For one-off / override invoices. Tasks auto-generate drafts.</p>
          </div>
          <button onClick={() => setPanelMode('detail')} className="p-1.5 hover:bg-foreground/5 rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Unsaved changes banner */}
        {newFormDirty && (
          <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-400 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Unsaved changes — navigating away will lose this form</span>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Client *</label>
            <Combobox
              options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
              value={newForm.client_id}
              onChange={v => setNewForm(p => ({ ...p, client_id: v }))}
              placeholder="Select client…"
              sortKey="clients"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Issue Date</label>
              <input type="date" value={newForm.issue_date}
                onChange={e => setNewForm(p => ({ ...p, issue_date: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Due Date</label>
              <input type="date" value={newForm.due_date}
                onChange={e => setNewForm(p => ({ ...p, due_date: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
              />
            </div>
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted-foreground">Line Items</label>
              <button onClick={() => setNewForm(p => ({ ...p, items: [...p.items, { description: '', quantity: 1, unit_price: 0, total: 0, service_id: '' }] }))}
                className="text-[10px] text-violet-400 hover:text-violet-300 flex items-center gap-1">
                <Plus className="w-3 h-3" />Add row
              </button>
            </div>
            <div className="space-y-2">
              {newForm.items.map((item, idx) => (
                <div key={idx} className="flex gap-2 items-start">
                  <input value={item.description} onChange={e => updateNewItem(idx, 'description', e.target.value)}
                    placeholder="Description…"
                    className="flex-1 bg-background border border-border/40 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-violet-500/50"
                  />
                  <input type="number" value={item.unit_price || ''} onChange={e => updateNewItem(idx, 'unit_price', parseFloat(e.target.value) || 0)}
                    placeholder={getCurrencySymbol(newForm.currency as any)}
                    className="w-20 bg-background border border-border/40 rounded-lg px-2 py-1.5 text-xs text-right focus:outline-none focus:border-violet-500/50"
                  />
                  {newForm.items.length > 1 && (
                    <button onClick={() => setNewForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) }))}
                      className="p-1.5 text-muted-foreground hover:text-red-400">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-between text-sm font-semibold border-t border-border/40 pt-3">
            <span>Total</span>
            <span>{fmt(total)}</span>
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Notes</label>
            <textarea value={newForm.notes} onChange={e => setNewForm(p => ({ ...p, notes: e.target.value }))}
              rows={2} placeholder="Optional notes…"
              className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-violet-500/50"
            />
          </div>

          <button onClick={createManualInvoice} disabled={saving || !newForm.client_id}
            className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors">
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
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-amber-400" />Generate Invoice
            </h3>
            <p className="text-[11px] text-muted-foreground">Pick a client + period → fetch done tasks → create invoice</p>
          </div>
          <button onClick={() => { setPanelMode('detail'); setGenTasks([]) }} className="p-1.5 hover:bg-foreground/5 rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">

          {/* Client */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Client *</label>
            <Combobox
              options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
              value={genForm.client_id}
              onChange={v => { setGenForm(p => ({ ...p, client_id: v })); setGenTasks([]) }}
              placeholder="Select client…"
              sortKey="clients"
            />
          </div>

          {/* Mode toggle */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Period Type</label>
            <div className="flex gap-1.5">
              {(['range', 'day'] as const).map(m => (
                <button key={m} onClick={() => setGenForm(p => ({ ...p, mode: m }))}
                  className={`flex-1 py-1.5 text-xs rounded-lg border transition-colors ${genForm.mode === m ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}>
                  {m === 'range' ? '📅 Date Range' : '📌 Specific Day'}
                </button>
              ))}
            </div>
          </div>

          {/* Date inputs */}
          {genForm.mode === 'range' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">From</label>
                <input type="date" value={genForm.date_from}
                  onChange={e => setGenForm(p => ({ ...p, date_from: e.target.value }))}
                  className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">To</label>
                <input type="date" value={genForm.date_to}
                  onChange={e => setGenForm(p => ({ ...p, date_to: e.target.value }))}
                  className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Date</label>
              <input type="date" value={genForm.specific_date}
                onChange={e => setGenForm(p => ({ ...p, specific_date: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
              />
            </div>
          )}

          {/* Fetch button */}
          <button onClick={fetchGenTasks} disabled={genLoading || !genForm.client_id}
            className="w-full py-2 bg-foreground/[0.06] hover:bg-foreground/[0.1] border border-border/40 text-sm font-medium rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50">
            <Search className="w-3.5 h-3.5" />
            {genLoading ? 'Fetching…' : 'Fetch Done Tasks'}
          </button>

          {/* Task list */}
          {genTasks.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Found {genTasks.length} task{genTasks.length !== 1 ? 's' : ''}
                </span>
                <div className="flex gap-2 text-[10px] text-violet-400">
                  <button onClick={() => setGenSelectedIds(new Set(genTasks.map(t => t.id)))}>All</button>
                  <span className="text-border">|</span>
                  <button onClick={() => setGenSelectedIds(new Set())}>None</button>
                </div>
              </div>
              <div className="space-y-1 max-h-52 overflow-y-auto">
                {genTasks.map(task => {
                    const existInvs: any[] = (task as any).existing_invoices || []
                    const activeConflict = existInvs.filter((inv: any) => inv.status !== 'cancelled')
                    const hasConflict = activeConflict.length > 0
                    return (
                  <label key={task.id} className={`flex items-start gap-2 p-2 rounded-lg border cursor-pointer transition-colors
                    ${hasConflict ? 'bg-amber-500/5 border-amber-500/30' : genSelectedIds.has(task.id) ? 'bg-violet-500/10 border-violet-500/30' : 'bg-foreground/[0.02] border-border/30 hover:border-border/60'}`}>
                    <input type="checkbox" checked={genSelectedIds.has(task.id)}
                      onChange={e => setGenSelectedIds(prev => {
                        const n = new Set(prev)
                        e.target.checked ? n.add(task.id) : n.delete(task.id)
                        return n
                      })}
                      className="accent-violet-500 mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{task.title}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {fmtDate(task.task_date)}{task.service?.name ? ` · ${task.service.name}` : ''}
                        {task.status === 'invoiced' && <span className="ml-1 text-amber-400">· invoiced</span>}
                      </div>
                      {hasConflict && (
                        <div className="mt-1 space-y-0.5">
                          {activeConflict.map((inv: any) => (
                            <div key={inv.id} className="text-[9px] text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 inline-flex items-center gap-1 mr-1">
                              ⚠️ Already in {inv.invoice_number} ({inv.status})
                            </div>
                          ))}
                          <div className="text-[9px] text-muted-foreground">Including will create a duplicate line item</div>
                        </div>
                      )}
                    </div>
                    <span className="text-xs font-semibold shrink-0">{fmt(task.billing_amount ?? task.billing_amount_inr ?? 0, task.currency || 'INR')}</span>
                  </label>
                    )
                  })}
              </div>

              {/* Summary + create */}
              <div className="mt-3 pt-3 border-t border-border/40 space-y-3">
                <div className="flex justify-between text-sm font-semibold">
                  <span>{selectedCount} item{selectedCount !== 1 ? 's' : ''} selected</span>
                  <span>{fmt(selectedTotal)}</span>
                </div>
                <button onClick={createFromGenTasks} disabled={saving || selectedCount === 0}
                  className="w-full py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors">
                  <FileText className="w-4 h-4" />
                  {saving ? 'Creating…' : `Create Invoice · ${fmt(selectedTotal)}`}
                </button>
              </div>
            </div>
          )}

          {genTasks.length === 0 && !genLoading && genForm.client_id && (
            <div className="text-xs text-muted-foreground text-center py-6 bg-foreground/[0.02] rounded-xl border border-dashed border-border/40">
              Click "Fetch Done Tasks" to see available tasks
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
      <div className="flex flex-col h-full overflow-hidden">

        {/* Header */}
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-1.5">
              <History className="w-4 h-4 text-emerald-400" />Batch Generate — Historical
            </h3>
            <p className="text-[11px] text-muted-foreground">Un-invoiced done tasks · grouped by client + month</p>
          </div>
          <button onClick={() => { setPanelMode('detail'); setBatchGroups([]) }} className="p-1.5 hover:bg-foreground/5 rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scan prompt */}
        {batchGroups.length === 0 && !batchLoading && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
            <History className="w-10 h-10 text-emerald-400/30" />
            <p className="text-sm text-muted-foreground">
              Scans all <strong>Done</strong> tasks without an active invoice, then groups them by client and billing month.
            </p>
            <button onClick={fetchBatchGroups}
              className="px-5 py-2.5 bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-sm font-medium rounded-xl transition-colors">
              Scan Un-invoiced Tasks
            </button>
          </div>
        )}

        {batchLoading && (
          <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span className="text-sm">Scanning tasks…</span>
          </div>
        )}

        {!batchLoading && batchGroups.length > 0 && (
          <>
            {/* ── Filter bar ─────────────────────────────────────────────── */}
            <div className="px-4 pt-3 pb-2 border-b border-border/30 space-y-2">

              {/* Row 1: Client search + Sort */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                  <input
                    type="text" placeholder="Filter by client…" value={batchFilterClient}
                    onChange={e => setBatchFilterClient(e.target.value)}
                    className="w-full pl-7 pr-2 py-1.5 text-xs bg-background border border-border/40 rounded-lg focus:outline-none focus:border-emerald-500/50"
                  />
                </div>
                <select value={batchSortBy} onChange={e => setBatchSortBy(e.target.value as any)}
                  className="text-xs bg-background border border-border/40 rounded-lg px-2 py-1.5 focus:outline-none focus:border-emerald-500/50 text-muted-foreground">
                  <option value="month_asc">Month ↑ (oldest)</option>
                  <option value="month_desc">Month ↓ (newest)</option>
                  <option value="client_asc">Client A→Z</option>
                  <option value="amount_desc">Amount ↓</option>
                </select>
              </div>

              {/* Row 2: Month range */}
              <div className="flex gap-2 items-center">
                <Calendar className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <div className="flex gap-1.5 flex-1">
                  <input type="month" value={batchFilterMonthFrom}
                    onChange={e => setBatchFilterMonthFrom(e.target.value)}
                    className="flex-1 text-xs bg-background border border-border/40 rounded-lg px-2 py-1.5 focus:outline-none focus:border-emerald-500/50 text-muted-foreground"
                    title="From month"
                  />
                  <span className="text-muted-foreground/50 text-xs self-center">→</span>
                  <input type="month" value={batchFilterMonthTo}
                    onChange={e => setBatchFilterMonthTo(e.target.value)}
                    className="flex-1 text-xs bg-background border border-border/40 rounded-lg px-2 py-1.5 focus:outline-none focus:border-emerald-500/50 text-muted-foreground"
                    title="To month"
                  />
                </div>
                <div className="relative">
                  <IndianRupee className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
                  <input type="number" placeholder="Min ₹" value={batchFilterMinAmount}
                    onChange={e => setBatchFilterMinAmount(e.target.value)}
                    className="w-20 pl-5 pr-2 py-1.5 text-xs bg-background border border-border/40 rounded-lg focus:outline-none focus:border-emerald-500/50"
                    title="Minimum invoice amount"
                  />
                </div>
                {hasFilters && (
                  <button onClick={clearFilters} className="text-[10px] text-red-400 hover:text-red-300 whitespace-nowrap" title="Clear all filters">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* Quick month shortcuts */}
              <div className="flex gap-1.5 flex-wrap">
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
                      className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${active ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300' : 'border-border/40 text-muted-foreground hover:border-emerald-500/30 hover:text-emerald-400'}`}>
                      {label}
                    </button>
                  )
                })}
              </div>

              {/* Summary + select controls */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">
                  {visibleGroups.length} / {batchGroups.length} groups
                  {hasFilters && <span className="text-amber-400 ml-1">(filtered)</span>}
                </span>
                <div className="flex gap-2 text-[10px] text-emerald-400">
                  <button onClick={() => {
                    const next = new Set(batchSelected)
                    visibleGroups.forEach(g => next.add(g.key))
                    setBatchSelected(next)
                  }}>Select visible</button>
                  <span className="text-border">|</span>
                  <button onClick={() => {
                    const next = new Set(batchSelected)
                    visibleGroups.forEach(g => next.delete(g.key))
                    setBatchSelected(next)
                  }}>Deselect visible</button>
                  <span className="text-border">|</span>
                  <button onClick={fetchBatchGroups} className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground">
                    <RefreshCw className="w-2.5 h-2.5" />Rescan
                  </button>
                </div>
              </div>
            </div>

            {/* ── Groups list ─────────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1">
              {visibleGroups.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
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
                    className={`rounded-lg border transition-colors ${checked ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-foreground/[0.02] border-border/30'}`}>

                    {/* ── Group header row ── */}
                    <div className="flex items-center gap-2 p-2.5">
                      <input type="checkbox" checked={checked}
                        onChange={e => {
                          const next = new Set(batchSelected)
                          if (e.target.checked) next.add(group.key); else next.delete(group.key)
                          setBatchSelected(next)
                        }}
                        className="w-3.5 h-3.5 accent-emerald-500 shrink-0"
                      />
                      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setBatchExpandedKey(expanded ? null : group.key)}>
                        <div className="text-xs font-medium truncate">{group.client_name}</div>
                        <div className="text-[10px] text-muted-foreground">{monthLabel} · {group.taskCount} task{group.taskCount !== 1 ? 's' : ''}{(group.expenses || []).length > 0 ? ` + ${group.expenses!.length} expense${group.expenses!.length > 1 ? 's' : ''}` : ''}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-semibold text-emerald-300">{fmt(group.total, group.currency as any)}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">INV-{invoiceYYMM}-NNN</div>
                      </div>
                      {/* Expand toggle */}
                      <button
                        onClick={() => setBatchExpandedKey(expanded ? null : group.key)}
                        title={expanded ? 'Collapse tasks' : 'Preview tasks'}
                        className={`shrink-0 p-1 rounded transition-colors ${expanded ? 'text-emerald-400 bg-emerald-500/10' : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'}`}>
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {/* ── Expanded task list ── */}
                    {expanded && (
                      <div className="border-t border-border/30 mx-2 mb-2 pt-2 space-y-0.5">
                        {groupTasks.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground px-1 py-1">No task details available</p>
                        ) : groupTasks.map((t, i) => (
                          <div key={t.id}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-foreground/[0.03] hover:bg-foreground/[0.06] transition-colors group">
                            <span className="text-[9px] text-muted-foreground/50 font-mono w-4 text-right shrink-0">{i + 1}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] text-foreground/90 truncate">{t.title}</div>
                              <div className="text-[9px] text-muted-foreground">
                                {t.task_date ? new Date(t.task_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
                              </div>
                            </div>
                            <div className="text-[11px] font-semibold text-foreground/80 shrink-0 tabular-nums">
                              {t.billing_amount_inr > 0 ? fmt(t.billing_amount_inr, t.currency as any) : <span className="text-muted-foreground/40 font-normal">—</span>}
                            </div>
                          </div>
                        ))}
                        {/* Expense entries for this month */}
                        {(group.expenses || []).map(exp => (
                          <div key={exp.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-500/[0.04] border border-amber-500/20">
                            <span className="text-[9px] text-amber-400/50 font-mono w-4 text-right shrink-0">
                              <ShoppingBag className="w-2.5 h-2.5" />
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] text-amber-300/80 truncate">{exp.description || 'Expense'}</div>
                              <div className="text-[9px] text-muted-foreground">
                                {exp.entry_date ? new Date(exp.entry_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'}
                              </div>
                            </div>
                            <div className="text-[11px] font-semibold text-amber-300/80 shrink-0 tabular-nums">
                              {fmt(exp.amount_inr, 'INR')}
                            </div>
                          </div>
                        ))}
                        {/* Group total */}
                        <div className="flex items-center justify-between px-2 pt-1.5 mt-0.5 border-t border-border/20">
                          <span className="text-[10px] text-muted-foreground">{groupTasks.length} tasks{(group.expenses || []).length > 0 ? ` + ${group.expenses!.length} expense${group.expenses!.length > 1 ? 's' : ''}` : ''} · subtotal</span>
                          <span className="text-[11px] font-bold text-emerald-400">{fmt(group.total + (group.expenses || []).reduce((s, e) => s + e.amount_inr, 0), group.currency as any)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ── Progress bar (while generating) ────────────────────────── */}
            {batchGenerating && (
              <div className="px-4 pb-2">
                <div className="bg-foreground/[0.04] border border-border/40 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2 text-xs text-muted-foreground">
                    <span>Generating invoices…</span>
                    <span>{batchDone} / {totalInvoices}</span>
                  </div>
                  <div className="h-1.5 bg-foreground/10 rounded-full overflow-hidden">
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
          <div className="px-4 py-3 border-t border-border/40 flex items-center justify-between gap-3">
            <div className="text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground">{totalInvoices}</span> selected
              {totalInvoices > 0 && <span className="ml-1.5 text-emerald-400">{fmt(totalAmount)}</span>}
            </div>
            <button onClick={runBatchGenerate} disabled={batchGenerating || totalInvoices === 0}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <Zap className="w-3.5 h-3.5" />
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
  function renderStatementPanel() {
    // ── Date range ────────────────────────────────────────────────────────
    let sFrom = '', sTo = '', sPeriodLabel = ''
    if (stmtForm.mode === 'month') {
      sFrom = stmtForm.month + '-01'
      const _d = new Date(stmtForm.month + '-01')
      const _ld = new Date(_d.getFullYear(), _d.getMonth() + 1, 0).getDate()
      sTo = `${stmtForm.month}-${String(_ld).padStart(2,'0')}`
      sPeriodLabel = new Date(sFrom + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    } else if (stmtForm.mode === 'year') {
      sFrom = `${stmtForm.year}-01-01`; sTo = `${stmtForm.year}-12-31`
      sPeriodLabel = stmtForm.year
    } else if (stmtForm.mode === 'day') {
      sFrom = sTo = stmtForm.specific_date
      sPeriodLabel = fmtDate(stmtForm.specific_date)
    } else {
      sFrom = stmtForm.date_from; sTo = stmtForm.date_to
      sPeriodLabel = sFrom && sTo ? `${fmtDate(sFrom)} – ${fmtDate(sTo)}` : 'Custom range'
    }

    const sInvoices = invoices
      .filter(inv => {
        if (stmtForm.client_id && inv.client_id !== stmtForm.client_id) return false
        const d = inv.issue_date || inv.created_at?.slice(0, 10) || ''
        return d >= sFrom && d <= sTo
      })
      .sort((a, b) => (a.issue_date || '').localeCompare(b.issue_date || ''))

    const sTotalBilled  = sInvoices.reduce((s, i) => s + (i.total_amount || 0), 0)
    const sTotalPaid    = sInvoices.reduce((s, i) => s + (i.paid_amount  || 0), 0)
    const sTotalBalance = sTotalBilled - sTotalPaid
    const sTotalTasks   = sInvoices.reduce((s, i) => s + (i.items?.length || 0), 0)
    const anyExpanded   = stmtExpandedIds.size > 0

    function toggleInv(id: string) {
      setStmtExpandedIds(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    return (
      <div className="flex flex-col h-full">

        {/* ── Header ── */}
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between shrink-0">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-1.5">
              <Receipt className="w-4 h-4 text-blue-400" />Statement Generator
            </h3>
            <p className="text-[11px] text-muted-foreground">Task-level ledger with received & balance</p>
          </div>
          <button type="button" onClick={() => setPanelMode('detail')}
            className="p-1.5 hover:bg-foreground/5 rounded-lg text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto">

          {/* Filters */}
          <div className="px-4 pt-4 pb-3 space-y-3">

            {/* Client */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Client</label>
              <Combobox
                options={[{ id: '', label: 'All Clients', sub: 'combined' }, ...clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))]}
                value={stmtForm.client_id}
                onChange={v => { setStmtForm(p => ({ ...p, client_id: v })); setStmtExpandedIds(new Set()) }}
                placeholder="All clients…"
                sortKey="clients"
              />
            </div>

            {/* Period type */}
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Period</label>
              <div className="grid grid-cols-2 gap-1.5">
                {([['month','📅 Month'],['year','📆 Year'],['range','🗓 Range'],['day','📌 Day']] as const).map(([m, lbl]) => (
                  <button type="button" key={m}
                    onClick={() => { setStmtForm(p => ({ ...p, mode: m })); setStmtExpandedIds(new Set()) }}
                    className={`py-1.5 text-xs rounded-lg border transition-colors ${stmtForm.mode === m ? 'bg-blue-500/20 border-blue-500/50 text-blue-300' : 'border-border/40 text-muted-foreground hover:border-border/70'}`}>
                    {lbl}
                  </button>
                ))}
              </div>
            </div>

            {/* Date value inputs */}
            {stmtForm.mode === 'month' && (
              <input type="month" value={stmtForm.month}
                onChange={e => setStmtForm(p => ({ ...p, month: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50" />
            )}
            {stmtForm.mode === 'year' && (
              <input type="number" min="2020" max="2099" value={stmtForm.year}
                onChange={e => setStmtForm(p => ({ ...p, year: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50" />
            )}
            {stmtForm.mode === 'range' && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">From</label>
                  <input type="date" value={stmtForm.date_from}
                    onChange={e => setStmtForm(p => ({ ...p, date_from: e.target.value }))}
                    className="w-full bg-background border border-border/40 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500/50" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">To</label>
                  <input type="date" value={stmtForm.date_to}
                    onChange={e => setStmtForm(p => ({ ...p, date_to: e.target.value }))}
                    className="w-full bg-background border border-border/40 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500/50" />
                </div>
              </div>
            )}
            {stmtForm.mode === 'day' && (
              <input type="date" value={stmtForm.specific_date}
                onChange={e => setStmtForm(p => ({ ...p, specific_date: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50" />
            )}
          </div>

          {/* ── No-results state ── */}
          {sInvoices.length === 0 ? (
            <div className="mx-4 my-2 py-8 text-xs text-muted-foreground text-center bg-foreground/[0.02] rounded-xl border border-dashed border-border/40">
              No invoices found in selected period
            </div>
          ) : (
            <>
              {/* ── Summary cards ── */}
              <div className="mx-4 mb-4 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-foreground/[0.04] border border-border/30 p-2.5 text-center">
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wide mb-1">Billed</div>
                  <div className="text-sm font-bold">{fmt(sTotalBilled)}</div>
                  <div className="text-[9px] text-muted-foreground mt-0.5">{sInvoices.length} inv · {sTotalTasks} tasks</div>
                </div>
                <div className="rounded-xl bg-emerald-500/[0.06] border border-emerald-500/20 p-2.5 text-center">
                  <div className="text-[9px] text-emerald-400/70 uppercase tracking-wide mb-1">Received</div>
                  <div className="text-sm font-bold text-emerald-400">{fmt(sTotalPaid)}</div>
                  <div className="text-[9px] text-muted-foreground mt-0.5">
                    {sTotalBilled > 0 ? Math.round(sTotalPaid / sTotalBilled * 100) : 0}%
                  </div>
                </div>
                <div className={`rounded-xl p-2.5 text-center border ${sTotalBalance > 0 ? 'bg-red-500/[0.06] border-red-500/20' : 'bg-emerald-500/[0.06] border-emerald-500/20'}`}>
                  <div className={`text-[9px] uppercase tracking-wide mb-1 ${sTotalBalance > 0 ? 'text-red-400/70' : 'text-emerald-400/70'}`}>Balance</div>
                  <div className={`text-sm font-bold ${sTotalBalance > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmt(Math.abs(sTotalBalance))}</div>
                  <div className="text-[9px] text-muted-foreground mt-0.5">{sTotalBalance > 0 ? 'due' : 'settled ✓'}</div>
                </div>
              </div>

              {/* ── Invoice accordion list ── */}
              <div className="px-4 pb-2">
                {/* List header */}
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    {sPeriodLabel} · {sInvoices.length} Invoice{sInvoices.length !== 1 ? 's' : ''}
                  </span>
                  <div className="flex gap-2">
                    <button type="button"
                      onClick={() => setStmtExpandedIds(new Set(sInvoices.map(i => i.id)))}
                      className="text-[10px] text-blue-400/70 hover:text-blue-400 transition-colors">
                      Expand all
                    </button>
                    {anyExpanded && (
                      <button type="button"
                        onClick={() => setStmtExpandedIds(new Set())}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                        Collapse
                      </button>
                    )}
                  </div>
                </div>

                {/* Cards */}
                <div className="space-y-2">
                  {sInvoices.map(inv => {
                    const balance     = Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0))
                    const isExpanded  = stmtExpandedIds.has(inv.id)
                    const overdue     = isOverdue(inv.due_date || '', inv.status)
                    const statusLbl   = overdue && inv.status !== 'paid' ? 'Overdue' : getStatusLabel(inv.status)
                    const isPaid      = inv.status === 'paid' || balance === 0
                    const isOver      = (overdue && inv.status !== 'paid') || inv.status === 'overdue'
                    const items       = [...(inv.items || [])].sort((a, b) => {
                      const da = a.task?.task_date || ''
                      const db = b.task?.task_date || ''
                      if (da && db) return da.localeCompare(db)
                      if (da) return -1
                      if (db) return 1
                      return (a.display_order ?? 0) - (b.display_order ?? 0)
                    })
                    const pmts        = inv.payments || []
                    const taskCount   = items.length

                    return (
                      <div key={inv.id}
                        className={`rounded-xl border transition-all ${isExpanded ? 'border-blue-500/40 bg-blue-500/[0.03]' : 'border-border/40 bg-foreground/[0.02] hover:border-border/60'}`}>

                        {/* ── Clickable header ── */}
                        <button
                          type="button"
                          className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left cursor-pointer"
                          onClick={() => toggleInv(inv.id)}>

                          {/* Chevron */}
                          <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90 text-blue-400' : ''}`} />

                          {/* Main info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-[11px] font-mono font-semibold text-foreground">{inv.invoice_number}</span>
                              {!stmtForm.client_id && inv.client?.name && (
                                <span className="text-[10px] text-muted-foreground/80 truncate max-w-[100px]">{inv.client.name}</span>
                              )}
                              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold ${
                                isPaid    ? 'bg-emerald-500/15 text-emerald-400' :
                                isOver    ? 'bg-red-500/15 text-red-400' :
                                inv.status === 'partial' ? 'bg-amber-500/15 text-amber-400' :
                                inv.status === 'reviewed' ? 'bg-blue-500/15 text-blue-400' :
                                'bg-foreground/10 text-muted-foreground'
                              }`}>{statusLbl}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="text-[9px] text-muted-foreground">{fmtDate(inv.issue_date)}</span>
                              {taskCount > 0 && <span className="text-[9px] text-muted-foreground">{taskCount} task{taskCount !== 1 ? 's' : ''}</span>}
                              {pmts.length > 0 && <span className="text-[9px] text-emerald-400/70">{pmts.length} pmt{pmts.length !== 1 ? 's' : ''}</span>}
                            </div>
                          </div>

                          {/* Amounts */}
                          <div className="text-right shrink-0 space-y-0.5">
                            <div className="text-xs font-bold tabular-nums">{fmt(inv.total_amount || 0)}</div>
                            {(inv.paid_amount || 0) > 0 && (
                              <div className="text-[10px] text-emerald-400 tabular-nums">rcvd {fmt(inv.paid_amount || 0)}</div>
                            )}
                            {balance > 0 && (
                              <div className="text-[10px] text-red-400 font-semibold tabular-nums">{fmt(balance)} due</div>
                            )}
                          </div>
                        </button>

                        {/* ── Expanded body ── */}
                        {isExpanded && (
                          <div className="border-t border-border/30 px-3 pb-3 pt-2.5 space-y-3">

                            {/* A. Line Items / Tasks */}
                            <div>
                              <div className="flex items-center gap-1.5 mb-1.5">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/60">
                                  {taskCount > 0 && items.some(it => it.task?.task_date) ? 'Tasks' : 'Line Items'}
                                </span>
                                <span className="text-[9px] text-muted-foreground/40">({taskCount})</span>
                              </div>
                              {taskCount === 0 ? (
                                /* No invoice_items rows — invoice total was set directly (e.g. imported from Sheets) */
                                <div className="px-2 py-2 rounded-lg bg-foreground/[0.03] border border-border/20">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[10px] text-muted-foreground/60 italic">
                                      No line-item breakdown available
                                    </span>
                                    <span className="text-[11px] font-bold tabular-nums">{fmt(inv.total_amount || 0)}</span>
                                  </div>
                                  <p className="text-[9px] text-muted-foreground/40 mt-0.5">
                                    Total was set directly — add items via invoice detail to see breakdown
                                  </p>
                                </div>
                              ) : (
                                <div className="space-y-1">
                                  {items.map((it, i) => (
                                    <div key={it.id ?? i}
                                      className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-foreground/[0.035] hover:bg-foreground/[0.06] transition-colors">
                                      <span className="text-[9px] text-muted-foreground/40 font-mono w-4 text-right shrink-0 mt-0.5">{i + 1}</span>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[11px] font-medium text-foreground/90 leading-tight">{it.description}</div>
                                        <div className="text-[9px] text-muted-foreground mt-0.5">
                                          {it.task?.task_date
                                            ? new Date(it.task.task_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
                                            : it.task?.title ? it.task.title : '—'}
                                          {it.service?.name && <span className="ml-1.5 opacity-60">· {it.service.name}</span>}
                                        </div>
                                      </div>
                                      <div className="text-[11px] font-semibold text-foreground/80 shrink-0 tabular-nums mt-0.5">
                                        {(it.total ?? 0) > 0
                                          ? fmt(it.total, it.currency as any)
                                          : <span className="text-muted-foreground/40 font-normal">—</span>}
                                      </div>
                                    </div>
                                  ))}
                                  {/* Subtotal row */}
                                  <div className="flex justify-between items-center px-2 pt-1.5 border-t border-border/20">
                                    <span className="text-[10px] text-muted-foreground">{taskCount} item{taskCount !== 1 ? 's' : ''}</span>
                                    <span className="text-[11px] font-bold tabular-nums">{fmt(inv.total_amount || 0)}</span>
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* B. Payments Received */}
                            <div>
                              <div className="flex items-center gap-1.5 mb-1.5">
                                <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/60">Payments Received</span>
                                <span className="text-[9px] text-muted-foreground/40">({pmts.length})</span>
                              </div>
                              {pmts.length === 0 ? (
                                <p className="text-[10px] text-muted-foreground/50 italic px-1">No payments recorded</p>
                              ) : (
                                <div className="space-y-1">
                                  {pmts.map((pmt: any, pi: number) => (
                                    <div key={pmt.id ?? pi}
                                      className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/15">
                                      <CheckCircle className="w-3 h-3 text-emerald-400 shrink-0" />
                                      <div className="flex-1 min-w-0">
                                        <div className="text-[10px] font-semibold text-emerald-300">
                                          {pmt.payment_date
                                            ? new Date(pmt.payment_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
                                            : '—'}
                                        </div>
                                        <div className="text-[9px] text-muted-foreground">
                                          {METHOD_LABEL[pmt.payment_method] || pmt.payment_method}
                                          {pmt.reference && <span className="ml-1 opacity-70">· {pmt.reference}</span>}
                                        </div>
                                      </div>
                                      <div className="text-[11px] font-bold text-emerald-400 tabular-nums">
                                        {fmt(pmt.amount)}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* C. Balance summary */}
                            <div className={`rounded-xl px-3 py-2.5 border ${isPaid ? 'bg-emerald-500/[0.08] border-emerald-500/25' : 'bg-red-500/[0.06] border-red-500/20'}`}>
                              <div className="flex justify-between items-center">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-muted-foreground w-16">Billed</span>
                                    <span className="text-[11px] font-semibold tabular-nums">{fmt(inv.total_amount || 0)}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-emerald-400/80 w-16">Received</span>
                                    <span className="text-[11px] font-semibold text-emerald-400 tabular-nums">{fmt(inv.paid_amount || 0)}</span>
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className={`text-base font-black tabular-nums ${isPaid ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {fmt(balance)}
                                  </div>
                                  <div className={`text-[9px] font-medium ${isPaid ? 'text-emerald-400/60' : 'text-red-400/60'}`}>
                                    {isPaid ? '✓ Settled' : 'outstanding'}
                                  </div>
                                </div>
                              </div>
                            </div>

                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {/* ── Print buttons ── */}
          <div className="px-4 pt-3 pb-5 space-y-2 border-t border-border/20 mt-3">
            <button type="button" onClick={printStatement} disabled={sInvoices.length === 0}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors">
              <Printer className="w-4 h-4" />Print Statement
            </button>
            <button type="button" onClick={printDetailedStatement} disabled={sInvoices.length === 0}
              className="w-full py-2.5 px-4 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 disabled:opacity-40 disabled:cursor-not-allowed border border-blue-500/30 text-blue-300 text-sm font-medium transition-colors flex items-center justify-center gap-2">
              <FileText className="w-4 h-4" />Print Detailed Statement
              <span className="text-[10px] opacity-60">(tasks · payments)</span>
            </button>
            <button type="button" onClick={exportDetailedStatementCSV} disabled={sInvoices.length === 0}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 disabled:opacity-40 disabled:cursor-not-allowed border border-emerald-500/30 text-emerald-300 text-sm font-medium transition-colors flex items-center justify-center gap-2">
              <Download className="w-4 h-4" />Export CSV
              <span className="text-[10px] opacity-60">(ledger worksheet)</span>
            </button>
          </div>

        </div>
      </div>
    )
  }

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
    const overdueInvs = invoices.filter(i => isOverdue(i.due_date || '', i.status) && i.status !== 'paid')
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
      { id: 'discounts'  as const, label: 'Discounts',  color: 'text-orange-400', active: 'bg-orange-500/20 border-orange-500/40 text-orange-300', count: discAnalytics.length },
      { id: 'bad_debts'  as const, label: 'Bad Debts',  color: 'text-red-400',    active: 'bg-red-500/20 border-red-500/40 text-red-300',          count: badDebtInvoices.length },
      { id: 'job_losses' as const, label: 'Job Losses', color: 'text-rose-400',   active: 'bg-rose-500/20 border-rose-500/40 text-rose-300',       count: jobLosses.length },
      { id: 'overdue'    as const, label: 'Overdue',    color: 'text-amber-400',  active: 'bg-amber-500/20 border-amber-500/40 text-amber-300',    count: overdueInvs.length },
      { id: 'advances'   as const, label: 'Advances',   color: 'text-blue-400',   active: 'bg-blue-500/20 border-blue-500/40 text-blue-300',       count: advancePayments.length },
      { id: 'expenses'   as const, label: 'Expenses',   color: 'text-amber-400',  active: 'bg-amber-500/20 border-amber-500/40 text-amber-300',    count: expenseReport.length },
    ]

    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-1.5">
              <TrendingUp className="w-4 h-4 text-violet-400" />Financial Analytics
            </h3>
            <p className="text-[11px] text-muted-foreground">Discounts · Bad debts · Overdue aging · Advances</p>
          </div>
          <button onClick={() => setPanelMode('detail')} className="p-1.5 hover:bg-foreground/5 rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 px-4 pt-2 pb-0 border-b border-border/40">
          {TABS.map(t => (
            <button key={t.id}
              onClick={() => {
                setAnalyticsTab(t.id)
                if (t.id === 'advances')  loadAdvancePayments()
                if (t.id === 'job_losses') loadJobLosses()
                if (t.id === 'expenses')  loadExpenseReport()
              }}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-t-lg border border-b-0 transition-colors ${analyticsTab === t.id ? t.active : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {t.label}
              {t.count > 0 && (
                <span className={`text-[9px] px-1 py-0.5 rounded-full ${analyticsTab === t.id ? 'bg-foreground/20' : 'bg-foreground/[0.06]'}`}>{t.count}</span>
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
                  <div className="text-sm font-bold text-orange-300">{fmt(totalDiscGiven)}</div>
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
                    <button onClick={() => setDiscFilterClient('')} className="text-[10px] text-orange-400 hover:text-orange-300">Clear ×</button>
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
                  <div className="text-sm font-bold text-red-300">{fmt(totalBadDebt)}</div>
                </div>
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-red-400/70 mb-0.5">Unrecovered</div>
                  <div className="text-sm font-bold text-red-300">{fmt(badDebtUnpaid)}</div>
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
                  <div className="text-sm font-bold text-rose-300">{fmt(totalLoss)}</div>
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
                  <div className="text-sm font-bold text-amber-300">{fmt(totalOverdue)}</div>
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
                  <div className="text-sm font-bold text-blue-300">{fmt(totalAdvance)}</div>
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
                      <div className="text-[10px] text-blue-400/60 mt-1">{fmtDate(p.payment_date)}</div>
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
                        <div className="text-sm font-bold text-amber-300">+₹{totalMarkup.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                      </div>
                      <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-green-400/70 mb-0.5">Rebill Revenue</div>
                        <div className="text-sm font-bold text-green-300">₹{totalBilled.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
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
                                <div className="font-mono font-semibold text-amber-300">
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
  const showRightPanel = selectedInv || ['new', 'generate', 'batch_generate', 'statement', 'discounts'].includes(panelMode)

  return (
    <div className="flex flex-col h-dvh bg-background text-foreground">
      <Header title="Invoices" />
      <ToastContainer toasts={toasts} onDismiss={dismiss} />

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
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Outstanding</span>
              <span className="font-bold text-foreground">{fmt(stats.outstanding)}</span>
            </span>
            {stats.overdueCount > 0 && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="font-semibold text-red-400">{stats.overdueCount} overdue</span>
              </>
            )}
            {stats.draftCount > 0 && (
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
            <div className="bg-foreground/[0.03] rounded-xl p-3 border border-border/30">
              <div className="text-[10px] text-muted-foreground mb-0.5">Outstanding</div>
              <div className="text-sm font-bold text-foreground">{fmt(stats.outstanding)}</div>
            </div>
            <div className={`bg-foreground/[0.03] rounded-xl p-3 border ${stats.overdueCount > 0 ? 'border-red-500/30' : 'border-border/30'}`}>
              <div className="text-[10px] text-muted-foreground mb-0.5">Overdue</div>
              <div className={`text-sm font-bold ${stats.overdueCount > 0 ? 'text-red-400' : 'text-foreground'}`}>
                {fmt(stats.overdueAmt)}
                {stats.overdueCount > 0 && <span className="ml-1 text-[10px]">({stats.overdueCount})</span>}
              </div>
            </div>
            <div className={`bg-foreground/[0.03] rounded-xl p-3 border ${stats.draftCount > 0 ? 'border-amber-500/30' : 'border-border/30'}`}>
              <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-1">
                <Zap className="w-2.5 h-2.5" />Auto Drafts
              </div>
              <div className={`text-sm font-bold ${stats.draftCount > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>
                {stats.draftCount > 0 ? `${stats.draftCount} · ${fmt(stats.draftTotal)}` : '—'}
              </div>
            </div>
            <button
              onClick={() => { setPanelMode('generate'); setSelectedId(null); setGenTasks([]) }}
              className={`rounded-xl p-3 border flex items-center gap-2 text-left transition-colors ${panelMode === 'generate' ? 'bg-amber-500/20 border-amber-500/40' : 'bg-amber-600/10 hover:bg-amber-600/20 border-amber-500/20'}`}>
              <Calendar className="w-4 h-4 text-amber-400 shrink-0" />
              <div>
                <div className="text-[10px] text-amber-300/70">Add-on</div>
                <div className="text-xs font-semibold text-amber-300">Generate</div>
              </div>
            </button>
            <button
              onClick={() => { setPanelMode('batch_generate'); setSelectedId(null); setBatchGroups([]); setBatchDone(0) }}
              className={`rounded-xl p-3 border flex items-center gap-2 text-left transition-colors ${panelMode === 'batch_generate' ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-emerald-600/10 hover:bg-emerald-600/20 border-emerald-500/20'}`}>
              <History className="w-4 h-4 text-emerald-400 shrink-0" />
              <div>
                <div className="text-[10px] text-emerald-300/70">Batch</div>
                <div className="text-xs font-semibold text-emerald-300">Historical</div>
              </div>
            </button>
            <button
              onClick={() => { setPanelMode('statement'); setSelectedId(null) }}
              className={`rounded-xl p-3 border flex items-center gap-2 text-left transition-colors ${panelMode === 'statement' ? 'bg-blue-500/20 border-blue-500/40' : 'bg-blue-600/10 hover:bg-blue-600/20 border-blue-500/20'}`}>
              <Receipt className="w-4 h-4 text-blue-400 shrink-0" />
              <div>
                <div className="text-[10px] text-blue-300/70">Account</div>
                <div className="text-xs font-semibold text-blue-300">Statement</div>
              </div>
            </button>
            <button
              onClick={() => { setPanelMode('discounts'); setSelectedId(null); loadDiscountAnalytics() }}
              className={`rounded-xl p-3 border flex items-center gap-2 text-left transition-colors ${panelMode === 'discounts' ? 'bg-violet-500/20 border-violet-500/40' : 'bg-violet-600/10 hover:bg-violet-600/20 border-violet-500/20'}`}>
              <TrendingUp className="w-4 h-4 text-violet-400 shrink-0" />
              <div>
                <div className="text-[10px] text-violet-300/70">Financial</div>
                <div className="text-xs font-semibold text-violet-300">Analytics</div>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex items-center gap-0 border-b border-border/40 px-4 pt-1">
        {(['active', 'closed'] as const).map(t => (
          <button key={t}
            onClick={() => { setTab(t); setFilterStatus('') }}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${tab === t ? 'border-violet-500 text-violet-300' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t === 'active' ? `Active (${invoices.filter(i => STATUS_GROUPS.active.includes(i.status) || (isOverdue(i.due_date || '', i.status) && i.status !== 'paid')).length})` : `Closed`}
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
          className="mb-1 flex items-center gap-1 text-[11px] font-medium text-violet-400 hover:text-violet-300 border border-violet-500/30 hover:border-violet-500/60 rounded-lg px-2.5 py-1 transition-colors bg-violet-500/5 hover:bg-violet-500/10">
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
            {panelMode === 'statement'      && renderStatementPanel()}
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
              <p className="text-xs mt-1 opacity-60">Tasks marked "done" auto-generate draft invoices</p>
            </div>
          </div>
        )}
      </div>

      {/* ── Edit Reason Modal ─────────────────────────────────────────────────── */}
      {/* ── Invoice Preview Modal ───────────────────────────────────────────── */}
      {previewInv && (
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
                <button onClick={() => printInvoice(previewInv)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-foreground/[0.06] hover:bg-foreground/10 text-xs font-medium text-foreground transition-colors border border-foreground/15">
                  <Printer className="w-3.5 h-3.5" />Print / Download
                </button>
                <button onClick={() => setPreviewInv(null)}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/5 rounded-lg transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* Invoice rendered in iframe */}
            <div className="flex-1 overflow-hidden bg-[#f5f7fa] rounded-b-2xl">
              <iframe
                srcDoc={buildInvoiceHtml(previewInv)}
                className="w-full h-full border-0"
                title="Invoice Preview"
                sandbox="allow-same-origin"
              />
            </div>
          </div>
        </ModalOverlay>
      )}

      {editReasonModal && (
        <ModalOverlay onClose={() => { setEditReasonModal(null); setEditReasonInput('') }}>
          <div className="bg-[#111827] border border-border/60 rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4 max-h-[90dvh] overflow-y-auto">
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

            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 mb-4 text-xs text-amber-300">
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
    </div>
  )
}
