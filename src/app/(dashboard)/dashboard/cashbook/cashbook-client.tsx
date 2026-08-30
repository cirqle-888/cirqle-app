'use client'

import { resolveBrandingUrl } from '@/lib/utils/branding'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { insertCashbookEntries, updateCashbookEntry, softDeleteCashbookEntry, fetchLiveRate, backupAndResetAllocations, toggleCashbookEntryReview } from './actions'
import { SCOPE_FILTER_OPTIONS, matchesScopeFilter, getScopeFilterLabel, type ScopeFilterValue } from '@/components/ui/scope-filter'
import { formatCompact, round2 } from '@/lib/calculations/currency'
import CurrencyAmountInput, { type RateSource } from '@/components/ui/currency-amount-input'
import { Plus, X, TrendingUp, TrendingDown, Minus, Upload, ShieldAlert, Trash2, Edit2, Link as LinkIcon, Save, Receipt, RefreshCw, Landmark, CheckCircle, ArrowLeftRight, Copy, Users, Sparkles, ChevronDown, Repeat, ArrowUpRight } from 'lucide-react'
import { DateFilter, matchesDateFilter } from '@/components/ui/date-filter'
import { ActiveFilterChips } from '@/components/ui/active-filter-chips'
import { TokenizedSearch, type SearchFacet } from '@/components/ui/tokenized-search'
import { recordMatchesFacets, type FacetFieldDef } from '@/lib/search/match-facets'
import { cn, ROW_INTERACTIVE_CLASS, BRANDED_PILL_BASE_CLASS, BRANDED_PILL_SELECTED_CLASS, BRANDED_PILL_ACTIVE_CLASS } from '@/lib/utils'
import type { DateFilterValue } from '@/components/ui/date-filter'
import Combobox from '@/components/ui/combobox'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import AppSelect from '@/components/ui/app-select'
import TagPicker from '@/components/ui/tag-picker'
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { computeEqualSplit } from '@/lib/finance/splits'
import type { Currency } from '@/types'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useRole } from '@/contexts/role-context'
import type { ReceiptInput } from '@/components/cashbook/receipt-modal'

import Link from 'next/link'
import { todayISO, formatISODateShort } from '@/lib/utils/local-date'

// Allocation modals (253 + 313 lines) only mount when an admin clicks Allocate
// on an entry. Split off the initial cashbook chunk.
const AllocationModal = dynamic(
  () => import('@/components/cashbook/allocation-modal'),
  { ssr: false },
)
const PayrollAllocationModal = dynamic(
  () => import('@/components/cashbook/payroll-allocation-modal'),
  { ssr: false },
)
// Receipt generator only mounts when the user clicks the receipt icon on an
// inflow entry. Lazy-loaded so jspdf stays out of the main bundle.
const ReceiptModal = dynamic(
  () => import('@/components/cashbook/receipt-modal'),
  { ssr: false },
)
const TransferModal = dynamic(
  () => import('@/components/cashbook/transfer-modal'),
  { ssr: false },
)

interface Entry {
  id: string
  type: 'inflow' | 'outflow'
  category_id: string
  bank_account_id?: string
  is_reviewed?: boolean
  // Monetary fields are optional because they are stripped from the payload
  // for viewers without `cashbook.view_amounts`. UI must coalesce or gate on
  // `showAmounts` before rendering.
  amount?: number
  currency: Currency
  amount_inr?: number
  entry_date: string
  description?: string
  reference?: string
  invoice_id?: string
  client_id?: string        // entity tag for per-client FIFO allocation
  // Finance dimension: 'client' | 'company'; null/undefined = untriaged.
  scope?: 'client' | 'company' | null
  exchange_rate?: number
  rate_source?: string
  receipt_number?: string | null
  transfer_ref?: string | null
  deleted_at?: string | null
  category?: { id: string; name: string; type: string }
  bank_account?: { id: string; name: string }
  direct_invoice?: any
  allocations?: {
    id: string;
    invoice_id: string;
    allocated_amount: number;
    deleted_at?: string | null;
    invoice?: {
      invoice_number: string;
      status: string;
      due_date: string;
      total_amount: number;
      paid_amount: number;
      // FX fields — added to query so drill-down can use invoice's book rate
      total_amount_inr?: number;
      exchange_rate?: number;
      currency?: string;
      client?: { id: string; name: string }
    }
  }[]
  payroll_allocations?: {
    id: string;
    payroll_id: string;
    allocated_amount: number;
    deleted_at?: string | null;
    payroll?: {
      net_salary: number;
      status: string;
      employee?: { name: string; cqid: string }
    }
  }[]
  expense_billings?: {
    id: string;
    invoice_id: string;
    invoice?: { invoice_number: string; status: string } | null
  }[]
  // Free-form spend tags (e.g. "Photoshop", "Design") — absent entirely on a
  // pre-migration DB (20260714160000).
  tags?: { tag: { id: string; name: string } }[]
  // Employees sharing this expense, split equally. Amount fields stripped
  // server-side for viewers without cashbook.view_amounts.
  employee_splits?: {
    id: string;
    employee_id: string;
    amount?: number;
    amount_inr?: number;
    employee?: { id: string; name: string; cqid: string }
  }[]
}

interface DueInvoice {
  id: string
  invoice_number: string
  status: string
  issue_date: string
  due_date: string
  total_amount: number
  paid_amount: number
  total_amount_inr?: number
  paid_amount_inr?: number
  exchange_rate?: number   // frozen book rate at issue — used for realised FX
  currency: string
  client_id?: string    // for per-client FIFO filtering
  client?: { id: string; name: string; code: string }
  // Present (non-empty) when the invoice already has direct "Record Payment"
  // rows — used to exclude it from cashbook allocation (mutual exclusion).
  payments?: { id: string }[]
}

/**
 * One line of a payment split: how much of this receipt settles one invoice.
 * Amounts are ₹ (INR) — the currency `cashbook_invoice_allocations` stores —
 * even when the entry itself is in a foreign currency.
 */
interface AllocLine {
  invoice_id: string
  amount: string
}

/** An invoice's outstanding balance in ₹, falling back to raw amounts for pre-FX rows. */
function outstandingInr(inv: { total_amount_inr?: number; total_amount?: number; paid_amount_inr?: number; paid_amount?: number }): number {
  return round2((inv.total_amount_inr ?? inv.total_amount ?? 0) - (inv.paid_amount_inr ?? inv.paid_amount ?? 0))
}

// Which category names trigger smart fields
const SMART: Record<string, string> = {
  'invoice':          'invoice',
  'credit return':    'credit_return',
  'credit given':     'credit_given',
  'salary':           'salary',
  'visiting charge':  'client_linked',
  'commission':       'client_linked',
  'online spend':     'client_linked',
  'cost recovery':    'client_linked',
}

interface PendingPayroll {
  id: string
  employee_id: string
  month: number
  year: number
  payslip_number?: string | null
  net_salary: number
  status: string
  employee?: { cqid: string; name: string }
}

interface Props {
  initialEntries: Entry[]
  categories: any[]
  bankAccounts: any[]
  exchangeRates: any[]
  dueInvoices: DueInvoice[]
  employees: any[]
  clients: any[]
  outstandingCredits: any[]
  /**
   * All pending payslips (status='pending'), pre-sorted newest-first by the
   * server (year desc, month desc). Used by the salary-expense smart section
   * to narrow the picker to the chosen employee and auto-default to their
   * latest unpaid payslip.
   */
  pendingPayrolls: PendingPayroll[]
  /**
   * Flattened company_settings lookup used by the receipt renderer to drop
   * the hardcoded Cirqle branding. Keys: `logo_url`, `company_name`,
   * `company_phone`, `company_website`. Missing keys are fine — the renderer
   * falls back to safe defaults.
   */
  companySettings: Record<string, string>
  /**
   * True when the viewer holds `cashbook.view_amounts`. When false, amount
   * and amount_inr are already absent from `initialEntries` (stripped
   * server-side); the client uses this flag to suppress the totals row,
   * inflow/outflow KPI cards, and the entry-row amount column.
   */
  showAmounts: boolean
  /** All known tag names, for the TagPicker's autocomplete. */
  allTags: string[]
}

const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

export default function CashBookClient({ initialEntries, categories, bankAccounts, exchangeRates, dueInvoices, employees, clients, outstandingCredits, pendingPayrolls, companySettings, showAmounts, allTags }: Props) {
  const { role } = useRole()
  const isAdmin = role === 'super_admin'
  // Employee names are private: show CQID by default and the real name only
  // when an admin has unlocked reveal. The expense-split picker previously
  // rendered `e.name || e.cqid`, i.e. the name whenever one existed.
  const { revealNames } = usePermissions()
  const maskEmployee = (e: { name?: string | null; cqid?: string | null } | null | undefined) =>
    displayEmployee({ name: e?.name ?? '', cqid: e?.cqid ?? '' }, { revealNames, canReveal: true })
  const [entries, setEntries] = useState<Entry[]>(initialEntries)
  const [showForm, setShowForm] = useState(false)
  const [showTransfer, setShowTransfer] = useState(false)
  const [formEditingId, setFormEditingId] = useState<string | null>(null)   // non-null = editing existing
  const [saving, setSaving] = useState(false)
  const router = useRouter()
  const pathname = usePathname()

  const searchParams = useSearchParams()

  const [filterType, setFilterType] = useState(searchParams.get('type') || '')
  const [filterMonth, setFilterMonth] = useState(searchParams.get('month') || '')
  const [searchFacets, setSearchFacets] = useState<SearchFacet[]>(() => {
    try { const raw = searchParams.get('sf'); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [searchDraft, setSearchDraft] = useState('')
  const activeFacets = useMemo<SearchFacet[]>(
    () => searchDraft.trim() ? [...searchFacets, { field: 'any', op: 'contains' as const, text: searchDraft.trim() }] : searchFacets,
    [searchFacets, searchDraft],
  )
  const [filterCategory, setFilterCategory] = useState(searchParams.get('category') || '')
  const [filterScope, setFilterScope] = useState<ScopeFilterValue>(
    (searchParams.get('scope') as ScopeFilterValue) || '',
  )
  const [filterAllocStatus, setFilterAllocStatus] = useState(searchParams.get('alloc') || '')
  const [filterClient, setFilterClient] = useState(searchParams.get('client') || '')
  const [filterTags, setFilterTags] = useState<string[]>(() => {
    try { const raw = searchParams.get('tags'); return raw ? JSON.parse(raw) : [] } catch { return [] }
  })
  const [sortDir, setSortDir] = useState(searchParams.get('sort') || 'desc') // date: desc = newest first
  const [filterMinAmount, setFilterMinAmount] = useState(searchParams.get('min') || '')
  const [filterMaxAmount, setFilterMaxAmount] = useState(searchParams.get('max') || '')

  // FX Report modal (hidden by default, opt-in)
  const [showFxReportModal, setShowFxReportModal] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())

    if (filterType) params.set('type', filterType); else params.delete('type')
    if (filterMonth) params.set('month', filterMonth); else params.delete('month')
    if (searchFacets.length) params.set('sf', JSON.stringify(searchFacets)); else params.delete('sf')
    if (filterCategory) params.set('category', filterCategory); else params.delete('category')
    if (filterScope) params.set('scope', filterScope); else params.delete('scope')
    if (filterAllocStatus) params.set('alloc', filterAllocStatus); else params.delete('alloc')
    if (filterClient) params.set('client', filterClient); else params.delete('client')
    if (filterTags.length) params.set('tags', JSON.stringify(filterTags)); else params.delete('tags')
    if (sortDir && sortDir !== 'desc') params.set('sort', sortDir); else params.delete('sort')
    if (filterMinAmount) params.set('min', filterMinAmount); else params.delete('min')
    if (filterMaxAmount) params.set('max', filterMaxAmount); else params.delete('max')

    const newQueryString = params.toString()
    if (newQueryString !== searchParams.toString()) {
      router.replace(`${pathname}?${newQueryString}`, { scroll: false })
    }
  }, [filterType, filterMonth, searchFacets, filterCategory, filterScope, filterAllocStatus, filterClient, filterTags, sortDir, filterMinAmount, filterMaxAmount, pathname, router, searchParams])

  // Deep-link focus: when arriving via `?focus=<entryId>` (e.g. from an invoice's
  // linked-payments list), scroll that row into view and flash a highlight once.
  useEffect(() => {
    const focusId = searchParams.get('focus')
    if (!focusId) return
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-entry-id="${focusId}"]`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('ring-2', 'ring-inset', 'ring-violet-500/60', 'bg-violet-500/5')
      setTimeout(() => el.classList.remove('ring-2', 'ring-inset', 'ring-violet-500/60', 'bg-violet-500/5'), 2600)
    }, 350)
    return () => clearTimeout(t)
    // Run once on mount for the initial focus target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [recurringMonths, setRecurringMonths] = useState(0) // 0 = not recurring

  // Inline edit state
  const [editingRow, setEditingRow] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Partial<Entry>>({})
  
  // Allocations modal state
  const [allocatingEntry, setAllocatingEntry] = useState<Entry | null>(null)
  const [allocatingPayrollEntry, setAllocatingPayrollEntry] = useState<Entry | null>(null)

  // Receipt generator state
  const [receiptEntry, setReceiptEntry] = useState<Entry | null>(null)

  const invoiceCategoryId = useMemo(() => categories.find(c => c.name.toLowerCase().includes('invoice'))?.id, [categories])
  const salaryCategoryId  = useMemo(() => categories.find(c => c.name.toLowerCase().includes('salary'))?.id, [categories])
  const defaultBankAccountId = useMemo(() => bankAccounts.find(b => b.is_default)?.id || '', [bankAccounts])

  const [form, setForm] = useState({
    type: 'inflow' as 'inflow' | 'outflow',
    category_id: invoiceCategoryId,
    bank_account_id: defaultBankAccountId,
    amount: '',
    currency: 'INR' as Currency,
    rate: '',
    amountInr: '',
    rateSource: 'settings' as RateSource,
    entry_date: todayISO(),
    description: '',
    reference: '',
    // How this receipt splits across invoices, in ₹. One line is the ordinary
    // "payment for INV-x" case; several lines let a single deposit settle
    // multiple invoices without a second trip to the invoice page.
    allocations: [] as AllocLine[],
    // UI-only filter: narrows the Invoice picker to a single client's pending
    // invoices. Not persisted — once an invoice is picked, the client is
    // implicit via the invoice. Auto-fills when an invoice is selected.
    client_filter_id: '',
    fully_paid: false,
    // Finance scope for entries with NO client: 'company' = Cirqle's own books
    // (feeds the Company P&L), '' = leave untriaged (client money, tag later).
    // When a client is tagged the entry is 'client'-scoped regardless.
    scope: '' as '' | 'company',
    // Free-form spend tags (e.g. "Photoshop", "Design") for ad-hoc reporting.
    tags: [] as string[],
    // Employees sharing this expense — split equally on save.
    splitEmployeeIds: [] as string[],
  })

  // True once the user edits the description by hand — stops the invoice
  // picker from overwriting their wording as split lines are added or removed.
  const [descTouched, setDescTouched] = useState(false)

  const supabase = createClient()

  const rateMap = useMemo(() => {
    const m: Record<string, number> = {}
    exchangeRates.forEach(r => { m[r.currency] = r.rate_to_inr })
    return m
  }, [exchangeRates])

  // Frozen "book rate" for a foreign inflow's realised FX gain/loss. Priority:
  //   1. The linked invoice's snapshotted exchange_rate — the rate the receivable
  //      was booked at. Stable forever, so a settled gain/loss never drifts.
  //      (exchange_rate === 1 on a non-INR invoice means "never snapshotted" — skip.)
  //   2. The entry's OWN stored exchange_rate — also frozen at creation. For a
  //      standalone receipt (no invoice booking) this self-reconciles to a ~0
  //      realised diff, which is correct: no booking baseline ⇒ no realised FX.
  // The live settings rate (rateMap) is deliberately NOT used, so reopening this
  // section can never change a past figure (the bug this replaces).
  const bookRateForEntry = useCallback((e: Entry): number => {
    const inv = (e.allocations ?? []).find(a => !a.deleted_at && a.invoice)?.invoice
    if (inv && (inv.exchange_rate ?? 0) > 0 && inv.exchange_rate !== 1) return inv.exchange_rate as number
    const own = e.exchange_rate ?? 0
    if (own > 0) return own
    const amt = e.amount ?? 0
    return amt > 0 ? round2((e.amount_inr ?? 0) / amt) : 0
  }, [])

  // ── FX gain/loss calculations ────────────────────────────────────────────────
  // Compare the amount_inr the user actually typed against what the stored book
  // rate would produce. Difference = realised exchange rate gain or loss.
  const fxCalcAmount    = parseFloat(form.amount) || 0
  const fxCalcCurrency  = form.currency as Currency
  // Book rate for the in-form FX indicator. Prefer the linked invoice's FROZEN
  // rate (from the entry being edited, or the invoice picked in the form) so the
  // realised gain/loss can't drift when the live settings rate refreshes. Fall
  // back to the live rate ONLY for a brand-new, not-yet-linked foreign entry,
  // where no snapshot exists yet.
  const fxLinkedInvoiceRate = useMemo(() => {
    const editing = formEditingId ? entries.find(e => e.id === formEditingId) : null
    const allocInv = (editing?.allocations ?? []).find(a => !a.deleted_at && a.invoice)?.invoice
    if (allocInv && (allocInv.exchange_rate ?? 0) > 0 && allocInv.exchange_rate !== 1) return allocInv.exchange_rate as number
    // On a split, the first line's invoice sets the book rate — every line of
    // one receipt shares the same client and therefore the same currency.
    const firstLineId = form.allocations[0]?.invoice_id
    if (firstLineId) {
      const inv = dueInvoices.find(i => i.id === firstLineId)
      if (inv && (inv.exchange_rate ?? 0) > 0 && inv.exchange_rate !== 1) return inv.exchange_rate as number
    }
    return 0
  }, [formEditingId, entries, form.allocations, dueInvoices])
  const fxBookRate      = fxLinkedInvoiceRate || rateMap[fxCalcCurrency] || 0
  const fxActualInr     = parseFloat(form.amountInr) || 0
  const fxExpectedInr   = fxCalcCurrency !== 'INR' && fxBookRate > 0
    ? round2(fxCalcAmount * fxBookRate)
    : 0
  const fxDiff = fxCalcCurrency !== 'INR' && fxBookRate > 0 && fxActualInr > 0 && fxCalcAmount > 0
    ? round2(fxActualInr - fxExpectedInr)
    : 0
  const fxDirection = Math.abs(fxDiff) > 0.005
    ? (fxDiff > 0 ? 'gain' : 'loss')
    : 'none'

  // Derive { rate, amountInr, rateSource } when amount/currency are set
  // programmatically (invoice link, "fully paid" auto-fill) so the FX widget
  // and stored values stay consistent without user interaction.
  function fxFor(amountStr: string, currency: Currency): { rate: string; amountInr: string; rateSource: RateSource } {
    if (currency === 'INR') return { rate: '1', amountInr: amountStr, rateSource: 'manual' }
    const r = rateMap[currency]
    const rate = r ? String(r) : ''
    const amountInr = amountStr === '' ? '' : String(round2((parseFloat(amountStr) || 0) * (parseFloat(rate) || 0)))
    return { rate, amountInr, rateSource: r ? 'settings' : 'manual' }
  }

  /** Open the Add form pre-filled from an existing entry but dated today (duplicate). */
  function openDuplicateForm(entry: Entry) {
    const cur = (entry.currency as Currency) ?? 'INR'
    const storedRate = entry.exchange_rate ?? (cur === 'INR' ? 1 : (rateMap[cur] || 1))
    setForm({
      type:            entry.type,
      category_id:     entry.category_id ?? '',
      bank_account_id: entry.bank_account_id ?? '',
      amount:          entry.amount != null ? String(entry.amount) : '',
      currency:        cur,
      rate:            cur === 'INR' ? '1' : String(storedRate),
      amountInr:       entry.amount_inr != null ? String(entry.amount_inr) : '',
      rateSource:      (entry.rate_source as RateSource) ?? (cur === 'INR' ? 'manual' : 'settings'),
      entry_date:      new Date().toISOString().slice(0, 10),
      description:     entry.description ?? '',
      reference:       '',
      allocations:     [],
      client_filter_id:  entry.client_id ?? '',
      fully_paid:      false,
      scope:           entry.scope === 'company' ? 'company' : '',
      tags:            (entry.tags ?? []).map(t => t.tag.name),
      // Splits aren't carried over on duplicate — a copied entry needs the
      // split re-decided (recomputing from the same employee set still works
      // via the form if the user re-adds them).
      splitEmployeeIds: [],
    })
    setFormEditingId(null)
    setRecurringMonths(0)
    setDescTouched(true)   // the copied description is the user's own wording
    setShowForm(true)
  }

  /** Open the full Add/Edit form pre-filled with an existing entry's data. */
  function openEditForm(entry: Entry) {
    const cur = (entry.currency as Currency) ?? 'INR'
    const storedRate = entry.exchange_rate ?? (cur === 'INR' ? 1 : (rateMap[cur] || 1))
    setForm({
      type:            entry.type,
      category_id:     entry.category_id ?? '',
      bank_account_id: entry.bank_account_id ?? '',
      amount:          entry.amount != null ? String(entry.amount) : '',
      currency:        cur,
      rate:            cur === 'INR' ? '1' : String(storedRate),
      amountInr:       entry.amount_inr != null ? String(entry.amount_inr) : '',
      rateSource:      (entry.rate_source as RateSource) ?? (cur === 'INR' ? 'manual' : 'settings'),
      entry_date:      entry.entry_date ?? new Date().toISOString().slice(0, 10),
      description:     entry.description ?? '',
      reference:       entry.reference ?? '',
      // Allocations are NOT edited here — updateCashbookEntry never touched
      // them, and silently re-writing an existing split from this form would
      // double-pay the invoices. The form points at the row's allocation
      // panel instead.
      allocations:       [],
      client_filter_id:  entry.client_id  ?? '',
      fully_paid:      false,
      scope:           entry.scope === 'company' ? 'company' : '',
      tags:            (entry.tags ?? []).map(t => t.tag.name),
      splitEmployeeIds: (entry.employee_splits ?? []).map(s => s.employee_id),
    })
    setSmartExtra(entry.client_id ? { client_id: entry.client_id } : {})
    setFormEditingId(entry.id)
    setRecurringMonths(0)
    setDescTouched(true)   // an existing description is the user's own wording
    setShowForm(true)
  }

  /** Fetch a live FX rate from the API, update rateMap in-place, return the result for the widget. */
  async function syncLiveRate(currency: string): Promise<{ rate: number; rateDate: string } | null> {
    const res = await fetchLiveRate(currency)
    if (!res.ok || !res.data) return null
    // Patch rateMap so fxFor() and the FX-gain panel use the fresh rate immediately
    // without waiting for a page reload.
    rateMap[currency] = res.data.rate
    return res.data
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const amount = parseFloat(form.amount) || 0
    const isBase = form.currency === 'INR'
    const exchange_rate = isBase ? 1 : (parseFloat(form.rate) || rateMap[form.currency] || 1)
    const amountInr = isBase ? amount : (parseFloat(form.amountInr) || round2(amount * exchange_rate))
    const rate_source: RateSource = isBase ? 'manual' : form.rateSource
    const rate_date = form.entry_date

    // ── EDIT MODE: update existing entry ────────────────────────────────────
    if (formEditingId) {
      const savedClientId = smartExtra.client_id || form.client_filter_id || null
      const savedScope = savedClientId ? ('client' as const) : (form.scope || null)
      const result = await updateCashbookEntry(formEditingId, {
        entry_date:      form.entry_date,
        type:            form.type,
        amount,
        amount_inr:      amountInr,
        currency:        form.currency,
        exchange_rate,
        rate_source,
        rate_date,
        category_id:     form.category_id,
        bank_account_id: form.bank_account_id || null,
        description:     form.description,
        reference:       form.reference,
        client_id:       savedClientId,
        scope:           savedScope,
        tags:            form.tags,
        employee_split_ids: form.type === 'outflow' ? form.splitEmployeeIds : [],
      })
      if (result.ok) {
        const savedSplitIds = form.type === 'outflow' ? form.splitEmployeeIds : []
        const splitShares = computeEqualSplit(amountInr, savedSplitIds)
        const nativeShares = computeEqualSplit(amount, savedSplitIds)
        setEntries(prev => prev.map(e =>
          e.id === formEditingId
            ? {
                ...e,
                type:            form.type,
                category_id:     form.category_id,
                bank_account_id: form.bank_account_id || undefined,
                amount,
                currency:        form.currency as Currency,
                amount_inr:      amountInr,
                exchange_rate,
                rate_source,
                entry_date:      form.entry_date,
                description:     form.description,
                reference:       form.reference,
                client_id:       savedClientId || undefined,
                scope:           savedScope,
                tags:            form.tags.map(name => ({ tag: { id: name, name } })),
                employee_splits: splitShares.map(s => ({
                  id: s.employeeId,
                  employee_id: s.employeeId,
                  amount: nativeShares.find(n => n.employeeId === s.employeeId)?.amount ?? s.amount,
                  amount_inr: s.amount,
                  employee: employees.find((emp: any) => emp.id === s.employeeId),
                })),
              }
            : e,
        ))
        setShowForm(false)
        setFormEditingId(null)
        setForm({ type: 'inflow', category_id: invoiceCategoryId, bank_account_id: defaultBankAccountId, amount: '', currency: 'INR', rate: '', amountInr: '', rateSource: 'settings', entry_date: todayISO(), description: '', reference: '', allocations: [], client_filter_id: '', fully_paid: false, scope: '', tags: [], splitEmployeeIds: [] })
        setDescTouched(false)
      }
      setSaving(false)
      return
    }

    // Build list of dates (base date + recurring copies).
    // Anchor on year/month/day and clamp the day to the target month's length so
    // month-overflow can't skip/duplicate months (e.g. Jan-31 + 1mo must be
    // Feb-28, not Mar-03). Format from local Y/M/D — never toISOString(), which
    // shifts a day earlier in Asia/Calcutta (UTC+5:30).
    const baseDates: string[] = [form.entry_date]
    if (recurringMonths > 0) {
      const [by, bm, bd] = form.entry_date.split('-').map(Number)
      for (let m = 1; m <= recurringMonths; m++) {
        const targetMonthIndex = (bm - 1) + m           // 0-based month, may exceed 11
        const y = by + Math.floor(targetMonthIndex / 12)
        const mo = targetMonthIndex % 12                // 0-based
        const lastDay = new Date(y, mo + 1, 0).getDate()
        const day = Math.min(bd, lastDay)
        baseDates.push(`${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
      }
    }

    // ── Invoice split ────────────────────────────────────────────────────────
    // One line covering the whole receipt takes the legacy path (invoice_id on
    // the entry, DB trigger allocates the full amount) so nothing changes for
    // the ordinary "payment for INV-x" case. Anything else — several invoices,
    // or one invoice taking only part of the money — is written as explicit
    // allocation rows server-side.
    // Lines only apply to invoice-category inflows — switching category hides
    // the picker, and stale lines must not leak into the payload.
    const splitLines = (isInvoiceCategory ? form.allocations : [])
      .map(l => ({ invoice_id: l.invoice_id, allocated_amount: round2(parseFloat(l.amount) || 0) }))
      .filter(l => l.invoice_id && l.allocated_amount > 0)
    const isLegacySingle =
      splitLines.length === 1 && Math.abs(splitLines[0].allocated_amount - amountInr) < 0.01

    // The client tag can come from either the smart section (client-linked
    // outflow categories) or the invoice-mode client filter — same rule the
    // edit path uses. A tagged client makes the money client-scoped; otherwise
    // the user's Books choice applies ('' = leave for triage).
    const insertClientId = smartExtra.client_id || form.client_filter_id || null
    const result = await insertCashbookEntries(
      baseDates,
      {
        type: form.type,
        category_id: form.category_id,
        bank_account_id: form.bank_account_id || null,
        amount,
        currency: form.currency,
        amount_inr: amountInr,
        exchange_rate,
        rate_source,
        rate_date,
        description: form.description,
        reference: form.reference,
        invoice_id: isLegacySingle ? splitLines[0].invoice_id : null,
        allocations: isLegacySingle ? [] : splitLines,
        // Persist the client tag so auto-allocation only considers this client's invoices.
        client_id: insertClientId,
        scope: insertClientId ? 'client' : (form.scope || null),
        tags: form.tags,
        employee_split_ids: form.type === 'outflow' ? form.splitEmployeeIds : [],
      },
      form.description,
      {
        mode: (smartMode as 'credit_given' | 'credit_return' | null),
        entity_type: smartExtra.entity_type,
        entity_id: smartExtra.entity_id || null,
        entity_other: smartExtra.entity_other,
        credit_id: smartExtra.credit_id,
      },
    )

    if (result.ok && result.data) {
      // The insert response doesn't echo tags/splits (they're saved in a
      // follow-up call server-side) — attach what we know we just submitted
      // so the new row(s) show them without a refresh.
      const insertSplitIds = form.type === 'outflow' ? form.splitEmployeeIds : []
      const allInserted = result.data.entries.map((e: any) => ({
        ...e,
        tags: form.tags.map(name => ({ tag: { id: name, name } })),
        employee_splits: computeEqualSplit(Number(e.amount_inr) || 0, insertSplitIds).map(s => ({
          id: s.employeeId,
          employee_id: s.employeeId,
          amount: computeEqualSplit(Number(e.amount) || 0, insertSplitIds).find(n => n.employeeId === s.employeeId)?.amount ?? s.amount,
          amount_inr: s.amount,
          employee: employees.find((emp: any) => emp.id === s.employeeId),
        })),
      }))
      // Add all inserted entries to local state (sorted newest first)
      setEntries(prev => [...[...allInserted].reverse(), ...prev])
      setShowForm(false)
      setRecurringMonths(0)
      setForm({ type: 'inflow', category_id: invoiceCategoryId, bank_account_id: defaultBankAccountId, amount: '', currency: 'INR', rate: '', amountInr: '', rateSource: 'settings', entry_date: todayISO(), description: '', reference: '', allocations: [], client_filter_id: '', fully_paid: false, scope: '', tags: [], splitEmployeeIds: [] })
      setDescTouched(false)
      // The entry saved but the DB rejected the split (over-allocation, or an
      // invoice that was settled from another tab meanwhile). Say so — the
      // money is banked, only the invoice links are missing.
      if (result.data.allocationError) {
        alert(`Entry saved, but the invoice split was rejected:\n\n${result.data.allocationError}\n\nOpen the entry's allocation panel (⚖) to link it manually.`)
      }
    } else if (!result.ok) {
      alert(result.error || 'Failed to save entry')
    }
    setSaving(false)
  }

  async function handleInlineSave() {
    if (!editingRow) return
    setSaving(true)

    // Find the original entry to preserve its stored exchange_rate
    const originalEntry = entries.find(e => e.id === editingRow)
    if (!originalEntry) {
      setSaving(false)
      return
    }

    const amount = Number(editForm.amount) ?? (originalEntry.amount || 0)
    const cur = (editForm.currency ?? originalEntry.currency ?? 'INR') as Currency
    const isBase = cur === 'INR'

    // IMPORTANT: Preserve the stored exchange_rate ONLY if currency hasn't changed.
    // If the user changed the currency, use the book rate for the NEW currency.
    const currencyChanged = editForm.currency && editForm.currency !== originalEntry.currency
    let exchange_rate: number
    let rate_source: RateSource

    if (isBase) {
      exchange_rate = 1
      rate_source = 'manual'
    } else if (currencyChanged) {
      // Currency was changed — use the book rate for the new currency
      exchange_rate = rateMap[cur] || 1
      rate_source = rateMap[cur] ? 'settings' : 'manual'
    } else {
      // Currency unchanged — preserve the stored rate (historical data is precious)
      exchange_rate = originalEntry.exchange_rate ?? (rateMap[cur] || 1)
      rate_source = (originalEntry.rate_source as RateSource) ?? 'settings'
    }

    // Recalculate INR using the (preserved or new) exchange rate
    const amount_inr = isBase ? amount : round2(amount * exchange_rate)
    const rate_date = editForm.entry_date ?? originalEntry.entry_date ?? todayISO()

    const result = await updateCashbookEntry(editingRow, {
      entry_date: editForm.entry_date ?? originalEntry.entry_date ?? todayISO(),
      amount,
      amount_inr,
      currency: cur,
      exchange_rate,
      rate_source,
      rate_date,
      category_id: editForm.category_id ?? originalEntry.category_id,
      bank_account_id: editForm.bank_account_id ?? originalEntry.bank_account_id ?? null,
      description: editForm.description ?? originalEntry.description ?? '',
      reference: editForm.reference ?? originalEntry.reference ?? '',
    })
    if (result.ok) {
      setEntries(prev => prev.map(e => e.id === editingRow ? {
        ...e,
        amount,
        amount_inr,
        exchange_rate,
        rate_source,
        rate_date,
        entry_date: editForm.entry_date ?? originalEntry.entry_date,
        description: editForm.description ?? originalEntry.description,
        reference: editForm.reference ?? originalEntry.reference,
        category_id: editForm.category_id ?? originalEntry.category_id,
        bank_account_id: editForm.bank_account_id ?? originalEntry.bank_account_id,
      } : e))
      setEditingRow(null)
      setEditForm({})
    }
    setSaving(false)
  }

  async function handleToggleReview(entry: Entry) {
    if (!entry.bank_account_id) return
    const newStatus = !entry.is_reviewed
    setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, is_reviewed: newStatus } : e))
    const res = await toggleCashbookEntryReview(entry.id, newStatus)
    if (!res.ok) {
      setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, is_reviewed: !newStatus } : e))
      alert(res.error || 'Failed to update review status')
    }
  }

  // In-app confirmation, NOT window.confirm: the desktop shell returns false
  // from native confirm without drawing a dialog, so Delete silently did
  // nothing there (same bug the Months screen fixed).
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  async function handleSoftDelete(entryId: string) {
    const result = await softDeleteCashbookEntry(entryId)
    if (result.ok) {
      // Remove from local list immediately (soft-deleted entries are hidden)
      setEntries(prev => prev.filter(e => e.id !== entryId))
    }
  }

  const today = todayISO()
  // Pending invoices for the Invoice picker — narrowed to a single client when
  // the user picks one in the Client filter. Sorted overdue-first then by due
  // date so the most-pressing receivables surface at the top.
  const sortedDueInvoices = useMemo(() => {
    const list = form.client_filter_id
      ? dueInvoices.filter(inv => inv.client?.id === form.client_filter_id)
      : dueInvoices
    return [...list].sort((a, b) => {
      const aOverdue = a.due_date && a.due_date < today
      const bOverdue = b.due_date && b.due_date < today
      if (aOverdue && !bOverdue) return -1
      if (!aOverdue && bOverdue) return 1
      return (a.due_date || '').localeCompare(b.due_date || '')
    })
  }, [dueInvoices, form.client_filter_id, today])

  const isInvoiceCategory = form.category_id === invoiceCategoryId && form.type === 'inflow'

  // Live equal-split preview for the employee cost-split section — recomputed
  // on every render from the current form amount, so it never drifts from
  // what will actually be saved.
  const formAmountInr = form.currency === 'INR'
    ? (parseFloat(form.amount) || 0)
    : (parseFloat(form.amountInr) || 0)
  const splitPreview = computeEqualSplit(formAmountInr, form.splitEmployeeIds)

  // ── Invoice split (multi-invoice allocation from the entry form) ────────────
  // The receipt is divided across invoices in ₹, so one deposit can settle
  // several invoices without a second pass through the invoice page. The DB
  // enforces the ceiling too (`validate_cashbook_allocation`); these figures
  // keep the user from hitting it.
  const allocTotal      = round2(form.allocations.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0))
  const allocUnassigned = round2(formAmountInr - allocTotal)
  const allocOver       = isInvoiceCategory && allocUnassigned < -0.01

  // One receipt settles one client's invoices. The first line locks the client
  // even if the filter chip above is later cleared — a payment from client A
  // must never land on client B's ledger.
  const allocClientId = useMemo(() => {
    const first = form.allocations[0]
    return (first ? dueInvoices.find(i => i.id === first.invoice_id)?.client?.id : '') || form.client_filter_id
  }, [form.allocations, form.client_filter_id, dueInvoices])

  /** Invoices this receipt can still be split across: same client, not already a line. */
  const allocCandidates = useMemo(() => {
    const taken = new Set(form.allocations.map(l => l.invoice_id))
    return sortedDueInvoices.filter(inv =>
      !taken.has(inv.id) &&
      outstandingInr(inv) > 0.01 &&
      (!allocClientId || inv.client?.id === allocClientId),
    )
  }, [sortedDueInvoices, form.allocations, allocClientId])

  /** Auto description for a split — kept in sync until the user types their own. */
  function describeAllocations(lines: AllocLine[]): string {
    if (lines.length === 0) return ''
    const invs = lines.map(l => dueInvoices.find(i => i.id === l.invoice_id)).filter(Boolean) as DueInvoice[]
    if (invs.length === 0) return ''
    const client = invs[0].client?.name
    return `Payment for ${invs.map(i => i.invoice_number).join(', ')}${client ? ` — ${client}` : ''}`
  }

  /** Add an invoice to the split, taking as much of the unassigned balance as it can absorb. */
  function addAllocation(invoiceId: string) {
    const inv = dueInvoices.find(i => i.id === invoiceId)
    if (!inv || form.allocations.some(l => l.invoice_id === invoiceId)) return

    const outInr = outstandingInr(inv)
    const isFirst = form.allocations.length === 0
    const amountBlank = !((parseFloat(form.amount) || 0) > 0)

    // First invoice on an empty form: adopt its currency and outstanding, the
    // way the old single-invoice picker did — "pay this one off" in one click.
    const seed = isFirst && amountBlank
      ? (() => {
          const cur = ((inv.currency as Currency) || 'INR')
          const outCcy = round2((inv.total_amount || 0) - (inv.paid_amount || 0))
          const amountStr = outCcy > 0 ? String(outCcy) : ''
          const fx = fxFor(amountStr, cur)
          return { amount: amountStr, currency: cur, rate: fx.rate, amountInr: fx.amountInr, rateSource: fx.rateSource }
        })()
      : null
    const entryInr = seed
      ? (seed.currency === 'INR' ? (parseFloat(seed.amount) || 0) : (parseFloat(seed.amountInr) || 0))
      : formAmountInr

    const remaining = round2(Math.max(0, entryInr - allocTotal))
    const give      = round2(Math.min(remaining, outInr))
    const lines: AllocLine[] = [...form.allocations, { invoice_id: invoiceId, amount: give > 0 ? String(give) : '' }]

    setForm(p => ({
      ...p,
      ...(seed ?? {}),
      allocations:      lines,
      client_filter_id: inv.client?.id || p.client_filter_id,
      fully_paid:       false,
      reference:        lines.length === 1 ? (inv.invoice_number || '') : '',
      description:      descTouched ? p.description : describeAllocations(lines),
    }))
  }

  function updateAllocation(invoiceId: string, amount: string) {
    setForm(p => ({ ...p, allocations: p.allocations.map(l => l.invoice_id === invoiceId ? { ...l, amount } : l) }))
  }

  function removeAllocation(invoiceId: string) {
    const lines = form.allocations.filter(l => l.invoice_id !== invoiceId)
    setForm(p => ({
      ...p,
      allocations: lines,
      reference:   lines.length === 1 ? (dueInvoices.find(i => i.id === lines[0].invoice_id)?.invoice_number || '') : '',
      description: descTouched ? p.description : describeAllocations(lines),
    }))
  }

  /**
   * Spread whatever is still unassigned over this client's open invoices,
   * oldest issue date first — the same FIFO order the allocation panel uses.
   * Invoices dated after the entry are skipped: paying a future invoice is a
   * deliberate advance, so it stays a manual pick.
   */
  function autoSplitRemaining() {
    let remaining = allocUnassigned
    if (remaining <= 0.01) return
    const lines = [...form.allocations]
    const candidates = [...allocCandidates]
      .filter(inv => !inv.issue_date || inv.issue_date <= form.entry_date)
      .sort((a, b) => (a.issue_date || '').localeCompare(b.issue_date || ''))

    for (const inv of candidates) {
      if (remaining <= 0.01) break
      const give = round2(Math.min(remaining, outstandingInr(inv)))
      if (give <= 0.01) continue
      lines.push({ invoice_id: inv.id, amount: String(give) })
      remaining = round2(remaining - give)
    }
    if (lines.length === form.allocations.length) return

    const firstInv = dueInvoices.find(i => i.id === lines[0].invoice_id)
    setForm(p => ({
      ...p,
      allocations:      lines,
      client_filter_id: firstInv?.client?.id || p.client_filter_id,
      // A single invoice number is a useful entry reference; across a split it
      // just duplicates what the allocations already say.
      reference:        lines.length === 1 ? (firstInv?.invoice_number || '') : '',
      description:      descTouched ? p.description : describeAllocations(lines),
    }))
  }

  // Determine smart mode from selected category name
  const selectedCat = categories.find(c => c.id === form.category_id)
  const smartMode = selectedCat ? (SMART[selectedCat.name.toLowerCase()] || null) : null

  // Tokenized search field map (Description / Reference / Category / Amount + operators).
  const CASHBOOK_FIELDS: Record<string, FacetFieldDef> = useMemo(() => ({
    description: { type: 'text',   get: (e: any) => e.description },
    reference:   { type: 'text',   get: (e: any) => e.reference },
    category:    { type: 'text',   get: (e: any) => e.category?.name },
    ...(showAmounts ? { amount: { type: 'number' as const, get: (e: any) => e.amount_inr } } : {}),
  }), [showAmounts])
  const cashbookGeneric = (e: any) =>
    `${e.description || ''} ${e.reference || ''} ${e.category?.name || ''} ${e.bank_account?.name || ''} ` +
    (e.allocations || []).map((a: any) => `${a.invoice?.invoice_number || ''} ${a.invoice?.client?.name || ''}`).join(' ')

  // Extra smart state (credit given/return, salary, client link)
  const [smartExtra, setSmartExtra] = useState<Record<string, string>>({})

  function resetSmart() { setSmartExtra({}) }

  const filteredEntries = useMemo(() => {
    let result = entries
    if (filterType) result = result.filter(e => e.type === filterType)
    if (filterMonth) result = result.filter(e => e.entry_date?.startsWith(filterMonth))
    if (filterCategory) result = result.filter(e => e.category_id === filterCategory)
    if (filterScope) result = result.filter(e => matchesScopeFilter(filterScope, e.scope))
    
    if (activeFacets.length) {
      result = result.filter(e => recordMatchesFacets(activeFacets, e, CASHBOOK_FIELDS, cashbookGeneric))
    }

    if (filterAllocStatus) {
      result = result.filter(e => {
        const isInv = e.category_id === invoiceCategoryId
        const isSal = e.category_id === salaryCategoryId
        if (!isInv && !isSal) return false

        const totalAlloc = isInv
          ? (e.allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0)
          : (e.payroll_allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0)

        const unallocated = (e.amount_inr || 0) - totalAlloc
        if (filterAllocStatus === 'unallocated') return unallocated > 0.01 && totalAlloc === 0
        if (filterAllocStatus === 'partial') return unallocated > 0.01 && totalAlloc > 0
        if (filterAllocStatus === 'fully') return unallocated <= 0.01 && unallocated >= -0.01
        if (filterAllocStatus === 'over') return unallocated < -0.01
        return true
      })
    }

    if (filterClient) {
      // Match the entry's tagged client OR any allocated invoice's client.
      result = result.filter(e =>
        e.client_id === filterClient ||
        e.allocations?.some(a => !a.deleted_at && a.invoice?.client?.id === filterClient)
      )
    }

    if (filterTags.length) {
      // Inclusive OR: match if the entry carries ANY of the selected tags.
      const wanted = new Set(filterTags)
      result = result.filter(e => (e.tags ?? []).some(t => wanted.has(t.tag.name)))
    }

    if (filterMinAmount) {
      const min = parseFloat(filterMinAmount)
      if (!isNaN(min)) result = result.filter(e => (e.amount_inr ?? 0) >= min)
    }
    if (filterMaxAmount) {
      const max = parseFloat(filterMaxAmount)
      if (!isNaN(max)) result = result.filter(e => (e.amount_inr ?? 0) <= max)
    }

    // Sort by date (stable tie-break by id so same-day order is consistent).
    result = [...result].sort((a, b) => {
      const d = (a.entry_date || '').localeCompare(b.entry_date || '')
      const cmp = d !== 0 ? d : String(a.id || '').localeCompare(String(b.id || ''))
      return sortDir === 'asc' ? cmp : -cmp
    })

    return result
  }, [entries, filterType, filterMonth, activeFacets, filterCategory, filterScope, filterAllocStatus, filterClient, filterTags, sortDir, filterMinAmount, filterMaxAmount, invoiceCategoryId, salaryCategoryId])

  const totalInflow  = filteredEntries.filter(e => e.type === 'inflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const totalOutflow = filteredEntries.filter(e => e.type === 'outflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const net = totalInflow - totalOutflow

  // Per-account balances — computed from ALL (non-deleted) entries (not filtered)
  // so the balance is always the true running total regardless of active filters.

  // Realised FX gain/loss (display only — no extra entries created).
  // Formula: Σ (actual_amount_inr − foreign_amount × book_rate) for all foreign inflows.
  // Positive = net gain (received more INR than book rate implied).
  // Negative = net loss.
  const realisedFxGainLoss = useMemo(() =>
    filteredEntries
      .filter(e => e.type === 'inflow' && e.currency !== 'INR' && (e.amount ?? 0) > 0 && (e.amount_inr ?? 0) > 0)
      .reduce((sum, e) => {
        const bookRate = bookRateForEntry(e)   // frozen (invoice → entry), never live
        if (!bookRate) return sum
        return round2(sum + round2((e.amount_inr ?? 0) - round2((e.amount ?? 0) * bookRate)))
      }, 0),
    [filteredEntries, bookRateForEntry],
  )

  // ── FX Gain/Loss by period ────────────────────────────────────────────────────
  //
  // Formula (per the accounting requirement):
  //   FX Gain/Loss = Actual INR Received − (Foreign Amount × Book Rate)
  //
  // "Book Rate" priority:
  //   1. Invoice's stored exchange_rate (set when the invoice was issued — stable,
  //      never changes, represents the rate the business originally expected).
  //   2. Current rateMap rate (only for entries with no invoice link — labelled
  //      "vs current rate" so the user knows it can drift).
  //
  // Using the INVOICE rate (not today's rate) ensures historical reports never
  // change when the exchange_rates table is updated.

  interface FxEntryDetail {
    entryId:       string
    entryDate:     string
    clientName:    string
    invoiceNumber: string
    foreignAmount: number
    currency:      string
    bookValueInr:  number   // foreign × invoice.exchange_rate (or rateMap fallback)
    actualInr:     number   // entry.amount_inr
    fxDiff:        number   // actualInr − bookValueInr
    rateSource:    'invoice' | 'rateMap'
  }

  interface FxPeriodRow {
    period:  string         // 'YYYY-MM'
    label:   string         // 'Jun 2026'
    fxDiff:  number
    count:   number
    entries: FxEntryDetail[]
  }

  const fxByMonth = useMemo((): FxPeriodRow[] => {
    const map: Record<string, FxPeriodRow> = {}

    entries
      .filter(e =>
        e.type === 'inflow' &&
        e.currency !== 'INR' &&
        (e.amount ?? 0) > 0 &&
        (e.amount_inr ?? 0) > 0 &&
        !e.deleted_at,
      )
      .forEach(e => {
        const actualInr  = e.amount_inr ?? 0
        const foreignAmt = e.amount ?? 0

        // Always use the FROZEN book rate (invoice snapshot → entry's own rate),
        // never the live settings rate, so historical periods never change.
        const activeAllocs = (e.allocations ?? []).filter(a => !a.deleted_at && a.invoice)
        const bookRate  = bookRateForEntry(e)
        if (!bookRate) return
        const bookValueInr = round2(foreignAmt * bookRate)
        const inv = activeAllocs[0]?.invoice
        const usedInvoiceRate = !!(inv && (inv.exchange_rate ?? 0) > 0 && inv.exchange_rate !== 1)
        const rateSourceLabel: 'invoice' | 'rateMap' = usedInvoiceRate ? 'invoice' : 'rateMap'
        const clientName    = inv?.client?.name ?? ''
        const invoiceNumber = inv?.invoice_number ?? ''

        const diff = round2(actualInr - bookValueInr)
        if (Math.abs(diff) < 0.005) return   // no meaningful FX movement

        const period = e.entry_date.slice(0, 7)
        const [yr, mo] = period.split('-')
        const label = new Date(Number(yr), Number(mo) - 1, 1)
          .toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })

        if (!map[period]) map[period] = { period, label, fxDiff: 0, count: 0, entries: [] }
        map[period].fxDiff = round2(map[period].fxDiff + diff)
        map[period].count++
        map[period].entries.push({
          entryId:       e.id,
          entryDate:     e.entry_date,
          clientName,
          invoiceNumber,
          foreignAmount: foreignAmt,
          currency:      e.currency as string,
          bookValueInr,
          actualInr,
          fxDiff:        diff,
          rateSource:    rateSourceLabel,
        })
      })

    return Object.values(map)
      .sort((a, b) => b.period.localeCompare(a.period))
      .map(row => ({
        ...row,
        entries: [...row.entries].sort((a, b) => b.fxDiff - a.fxDiff),
      }))
  }, [entries, bookRateForEntry])

  const fxByYear = useMemo(() => {
    const map: Record<string, { year: string; fxDiff: number; count: number; entries: FxEntryDetail[] }> = {}
    fxByMonth.forEach(m => {
      const yr = m.period.slice(0, 4)
      if (!map[yr]) map[yr] = { year: yr, fxDiff: 0, count: 0, entries: [] }
      map[yr].fxDiff = round2(map[yr].fxDiff + m.fxDiff)
      map[yr].count  += m.count
      map[yr].entries.push(...m.entries)
    })
    return Object.values(map).sort((a, b) => b.year.localeCompare(a.year))
  }, [fxByMonth])

  const [showFxReport,  setShowFxReport]  = useState(false)
  const [fxPeriodView,  setFxPeriodView]  = useState<'month' | 'year'>('month')
  const [fxExpandedRow, setFxExpandedRow] = useState<string | null>(null)

  const inflowCategories = categories.filter(c => c.type === 'inflow' || c.type === 'both')
  const outflowCategories = categories.filter(c => c.type === 'outflow' || c.type === 'both')
  const relevantCategories = form.type === 'inflow' ? inflowCategories : outflowCategories

  // Sort categories by most recently used — looks up the latest entry_date for
  // each category_id across all entries. Categories with no usage sort last.
  const categoriesByRecentUse = useMemo(() => {
    const lastUsed: Record<string, string> = {}
    for (const e of entries) {
      if (e.category_id && e.entry_date) {
        if (!lastUsed[e.category_id] || e.entry_date > lastUsed[e.category_id]) {
          lastUsed[e.category_id] = e.entry_date
        }
      }
    }
    return [...categories].sort((a, b) => {
      const aDate = lastUsed[a.id] ?? ''
      const bDate = lastUsed[b.id] ?? ''
      if (bDate && !aDate) return 1
      if (aDate && !bDate) return -1
      return bDate.localeCompare(aDate)
    })
  }, [categories, entries])

  // ── Smart Mode: with a month filter active, the Category/Client filter
  // dropdowns only offer values present in that month's entries (the current
  // selection is kept so it stays clearable).
  const monthEntries = useMemo(
    () => (filterMonth ? entries.filter(e => e.entry_date?.startsWith(filterMonth)) : null),
    [entries, filterMonth],
  )
  const scopedFilterCategories = useMemo(() => {
    if (!monthEntries) return categoriesByRecentUse
    const ids = new Set(monthEntries.map(e => e.category_id).filter(Boolean))
    return categoriesByRecentUse.filter(c => ids.has(c.id) || c.id === filterCategory)
  }, [monthEntries, categoriesByRecentUse, filterCategory])
  // Clients ordered by most recent cashbook activity (direct or via allocation),
  // then narrowed to the filtered month when one is selected.
  const scopedFilterClients = useMemo(() => {
    const lastUsed: Record<string, string> = {}
    const touch = (id: string | null | undefined, date: string | null | undefined) => {
      if (id && date && (!lastUsed[id] || date > lastUsed[id])) lastUsed[id] = date
    }
    for (const e of entries) {
      touch(e.client_id, e.entry_date)
      e.allocations?.forEach((a: any) => { if (!a.deleted_at) touch(a.invoice?.client?.id, e.entry_date) })
    }
    const ordered = [...clients].sort((a, b) => {
      const aD = lastUsed[a.id] ?? '', bD = lastUsed[b.id] ?? ''
      if (bD && !aD) return 1
      if (aD && !bD) return -1
      if (aD !== bD) return bD.localeCompare(aD)
      return a.name.localeCompare(b.name)
    })
    if (!monthEntries) return ordered
    const inMonth = new Set<string>()
    for (const e of monthEntries) {
      if (e.client_id) inMonth.add(e.client_id)
      e.allocations?.forEach((a: any) => { if (!a.deleted_at && a.invoice?.client?.id) inMonth.add(a.invoice.client.id) })
    }
    return ordered.filter(c => inMonth.has(c.id) || c.id === filterClient)
  }, [entries, clients, monthEntries, filterClient])

  return (
    <div>
      <Header
        title="Cash Book"
        subtitle="Track all income and expenses"
        actions={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/cashbook/accounts"
              className="flex items-center gap-1.5 bg-secondary text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors whitespace-nowrap"
              title="Account balances & ledger">
              <Landmark className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Accounts</span>
            </Link>
            <Link href="/dashboard/cashbook/reconciliation"
              className="flex items-center gap-1.5 bg-secondary text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors whitespace-nowrap">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Reconciliation</span>
            </Link>

            <button onClick={() => setShowTransfer(true)}
              className="flex items-center gap-1.5 bg-secondary text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors whitespace-nowrap">
              <ArrowLeftRight className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">Transfer</span>
            </button>
            <button onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap">
              <Plus className="w-4 h-4 shrink-0" />
              Add Entry
            </button>
            {realisedFxGainLoss !== 0 && (
              <button onClick={() => setShowFxReportModal(true)}
                className="flex items-center gap-1.5 bg-secondary text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors whitespace-nowrap"
                title="View FX Gain/Loss report">
                <TrendingUp className="w-4 h-4 shrink-0" />
                <span className="hidden sm:inline">FX Report</span>
              </button>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-5">
        {/* Summary — only rendered when the viewer can see ₹ amounts. Without
            cashbook.view_amounts the totals would collapse to ₹0 and mislead. */}
        {showAmounts && (
          <div className={`grid gap-4 ${realisedFxGainLoss !== 0 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2 sm:grid-cols-3'}`}>
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-green-400" />
                <p className="text-xs text-muted-foreground">Inflow</p>
              </div>
              <p className="text-xl font-bold text-green-400">{formatCompact(totalInflow)}</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <TrendingDown className="w-4 h-4 text-red-400" />
                <p className="text-xs text-muted-foreground">Outflow</p>
              </div>
              <p className="text-xl font-bold text-red-400">{formatCompact(totalOutflow)}</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <Minus className="w-4 h-4 text-primary" />
                <p className="text-xs text-muted-foreground">Net</p>
              </div>
              <p className={`text-xl font-bold ${net >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatCompact(Math.abs(net))}</p>
            </div>
            {realisedFxGainLoss !== 0 && (
              <div className={`bg-card border rounded-xl p-4 ${realisedFxGainLoss > 0 ? 'border-green-500/25' : 'border-red-500/25'}`}>
                <div className="flex items-center gap-2 mb-1">
                  {realisedFxGainLoss > 0
                    ? <TrendingUp  className="w-4 h-4 text-green-400" />
                    : <TrendingDown className="w-4 h-4 text-red-400" />}
                  <p className="text-xs text-muted-foreground">FX {realisedFxGainLoss > 0 ? 'Gain' : 'Loss'}</p>
                </div>
                <p className={`text-xl font-bold ${realisedFxGainLoss > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {realisedFxGainLoss > 0 ? '+' : '-'}{formatCompact(Math.abs(realisedFxGainLoss))}
                </p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">vs book rate · display only</p>
              </div>
            )}
          </div>
        )}


        {/* Filters */}
        <div className="flex flex-col lg:flex-row gap-3 bg-secondary/20 p-3 rounded-xl border border-border">
          {/* Row 1: Search */}
          <div className="w-full lg:flex-1 shrink-0">
            <TokenizedSearch
              className="w-full"
              facets={searchFacets}
              onFacetsChange={setSearchFacets}
              draft={searchDraft}
              onDraftChange={setSearchDraft}
              placeholder="Search descriptions, clients..."
              resultCount={filteredEntries.length}
              resultNoun="entry"
              fields={[
                { key: 'description', label: 'Description', type: 'text' },
                { key: 'reference', label: 'Reference', type: 'text' },
                { key: 'category', label: 'Category', type: 'text' },
                ...(showAmounts ? [{ key: 'amount', label: 'Amount ₹', type: 'number' as const }] : []),
              ]}
            />
          </div>

          {/* Row 2: Filters */}
          <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar w-full lg:w-auto shrink-0 pb-1 lg:pb-0 [&>*]:shrink-0">
            <div className="flex gap-1.5">
              {['', 'inflow', 'outflow'].map(t => (
                <button key={t} onClick={() => setFilterType(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filterType === t ? 'gradient-bg text-white' : 'bg-background text-muted-foreground border hover:text-foreground'}`}>
                  {t ? (t === 'inflow' ? 'Income' : 'Expense') : 'All'}
                </button>
              ))}
            </div>
            
            <div className="h-5 w-px bg-border hidden sm:block"></div>

            <input
              type="month"
              value={filterMonth}
              onChange={e => setFilterMonth(e.target.value)}
              className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            
            <select 
              value={filterCategory} 
              onChange={e => setFilterCategory(e.target.value)}
              className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 max-w-[150px]"
            >
              <option value="">All Categories</option>
              {scopedFilterCategories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            <select
              value={filterScope}
              onChange={e => setFilterScope(e.target.value as ScopeFilterValue)}
              className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {SCOPE_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <select
              value={filterAllocStatus}
              onChange={e => setFilterAllocStatus(e.target.value)}
              className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">Invoice link: any</option>
              <option value="unallocated">Not linked to an invoice</option>
              <option value="partial">Partly linked</option>
              <option value="fully">Fully linked</option>
              <option value="over">Linked to more than received</option>
            </select>

            <select
              value={filterClient}
              onChange={e => setFilterClient(e.target.value)}
              className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 max-w-[170px]"
            >
              <option value="">All Clients</option>
              {scopedFilterClients.map(c => <option key={c.id} value={c.id}>{c.code ? `${c.name} · ${c.code}` : c.name}</option>)}
            </select>

            <FilterDropdown
              options={allTags.map(t => ({ value: t, label: t }))}
              value=""
              onChange={() => {}}
              placeholder="Tags"
              compact
              multiple
              values={filterTags}
              onToggle={t => setFilterTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])}
              onClear={() => setFilterTags([])}
            />

            <button
              type="button"
              onClick={() => setSortDir(d => d === 'desc' ? 'asc' : 'desc')}
              title={sortDir === 'desc' ? 'Date: newest first (click for oldest first)' : 'Date: oldest first (click for newest first)'}
              className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 hover:bg-secondary/50 transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              Date {sortDir === 'desc' ? '↓ Newest' : '↑ Oldest'}
            </button>

            {/* Amount range */}
            <div className="flex items-center gap-1">
              <input
                type="number"
                placeholder="Min ₹"
                value={filterMinAmount}
                onChange={e => setFilterMinAmount(e.target.value)}
                className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 w-24"
              />
              <span className="text-muted-foreground text-xs">–</span>
              <input
                type="number"
                placeholder="Max ₹"
                value={filterMaxAmount}
                onChange={e => setFilterMaxAmount(e.target.value)}
                className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 w-24"
              />
            </div>

            {(filterType || filterMonth || filterCategory || filterScope || searchFacets.length || filterAllocStatus || filterMinAmount || filterMaxAmount || filterTags.length > 0) && (
              <button onClick={() => { setFilterType(''); setFilterMonth(''); setFilterCategory(''); setFilterScope(''); setSearchFacets([]); setSearchDraft(''); setFilterAllocStatus(''); setFilterMinAmount(''); setFilterMaxAmount(''); setFilterTags([]) }} className="text-xs text-muted-foreground hover:text-foreground px-2 whitespace-nowrap">Clear</button>
            )}
          </div>
        </div>

        {/* Tokenized active filters (ERPNext-style chips) */}
        <ActiveFilterChips
          className="mb-3"
          chips={[
            ...(filterType ? [{ key: 'type', label: 'Type', value: filterType === 'inflow' ? 'Income' : 'Expense', onRemove: () => setFilterType('') }] : []),
            ...(filterCategory ? [{ key: 'category', label: 'Category', value: categories.find((c: any) => c.id === filterCategory)?.name || 'Selected', onRemove: () => setFilterCategory('') }] : []),
            ...(filterScope ? [{ key: 'scope', label: 'Whose money', value: getScopeFilterLabel(filterScope), onRemove: () => setFilterScope('') }] : []),
            ...(filterClient ? [{ key: 'client', label: 'Client', value: clients.find((c: any) => c.id === filterClient)?.name || 'Selected', onRemove: () => setFilterClient('') }] : []),
            ...(filterMonth ? [{ key: 'month', label: 'Month', value: filterMonth, onRemove: () => setFilterMonth('') }] : []),
            ...(filterAllocStatus ? [{ key: 'alloc', label: 'Allocation', value: filterAllocStatus, onRemove: () => setFilterAllocStatus('') }] : []),
            ...(filterMinAmount ? [{ key: 'min', label: 'Min ₹', value: filterMinAmount, onRemove: () => setFilterMinAmount('') }] : []),
            ...(filterMaxAmount ? [{ key: 'max', label: 'Max ₹', value: filterMaxAmount, onRemove: () => setFilterMaxAmount('') }] : []),
            ...filterTags.map(t => ({ key: `tag:${t}`, label: 'Tag', value: t, onRemove: () => setFilterTags(prev => prev.filter(x => x !== t)) })),
          ]}
          onClearAll={() => { setFilterType(''); setFilterMonth(''); setFilterCategory(''); setFilterScope(''); setSearchFacets([]); setSearchDraft(''); setFilterAllocStatus(''); setFilterMinAmount(''); setFilterMaxAmount(''); setFilterClient(''); setFilterTags([]) }}
        />

        {/* Entries */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {/* Mobile / Tablet Card View */}
          <div className="grid grid-cols-1 divide-y divide-border lg:hidden">
            {filteredEntries.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">No entries found</div>
            )}
            {filteredEntries.map(entry => {
              const isInvoice = entry.category_id === invoiceCategoryId
              const isSalary = entry.category_id === salaryCategoryId
              
              let totalAlloc = 0
              if (isInvoice) totalAlloc = entry.allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0
              if (isSalary) totalAlloc = entry.payroll_allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0
              
              const unallocated = (entry.amount_inr || 0) - totalAlloc
              const allocStatus = (!isInvoice && !isSalary) ? null : unallocated <= 0.01 && unallocated >= -0.01 ? 'fully' : unallocated > 0.01 && totalAlloc > 0 ? 'partial' : unallocated < -0.01 ? 'over' : 'none'
              const isEditing = editingRow === entry.id

              return (
                <div key={entry.id} data-entry-id={entry.id} className={`hover-gradient-row flex flex-col`}>
                  <div className="p-4 flex justify-between items-start gap-4">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${entry.type === 'inflow' ? 'bg-green-400' : 'bg-red-400'}`} />
                      {isEditing ? (
                        <select value={editForm.category_id || ''} onChange={e => setEditForm(p => ({...p, category_id: e.target.value}))} className="bg-background border rounded px-2 py-1 text-xs">
                          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      ) : (
                        <span className="text-sm font-medium">{entry.category?.name || '—'}</span>
                      )}
                    </div>
                    <div className={`text-right font-semibold ${entry.type === 'inflow' ? 'text-green-400' : 'text-red-400'}`}>
                      {isEditing ? (
                        <div className="flex gap-1 justify-end">
                          <input type="number" value={editForm.amount || ''} onChange={e => setEditForm(p => ({...p, amount: Number(e.target.value)}))} className="bg-background border rounded px-2 py-1 w-20 text-xs" />
                          <select value={editForm.currency || ''} onChange={e => setEditForm(p => ({...p, currency: e.target.value as Currency}))} className="bg-background border rounded px-1 py-1 text-xs">
                            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      ) : (
                        <>
                          {showAmounts ? (
                            <>
                              {entry.type === 'inflow' ? '+' : '-'}₹{(entry.amount_inr ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              {entry.currency !== 'INR' && <span className="text-xs text-muted-foreground ml-1">({entry.currency} {entry.amount?.toLocaleString()})</span>}
                            </>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  <div className="px-4 pb-4 flex flex-col gap-3">
                    {/* Description */}
                    <div className="text-sm space-y-1">
                      {isEditing ? (
                        <input type="text" value={editForm.description || ''} onChange={e => setEditForm(p => ({...p, description: e.target.value}))} className="w-full bg-background border rounded px-2 py-1 text-xs" placeholder="Description" />
                      ) : (
                        entry.description || <span className="text-muted-foreground italic">No description</span>
                      )}
                      {entry.transfer_ref && <span className="inline-flex items-center gap-1 bg-purple-500/10 text-purple-400 text-[10px] px-1.5 py-0.5 rounded font-medium"><ArrowLeftRight className="w-3 h-3" />Internal Transfer</span>}
                      {((entry.tags?.length ?? 0) > 0 || (entry.employee_splits?.length ?? 0) > 0) && (
                        <div className="flex flex-wrap gap-1">
                          {entry.tags?.map(t => (
                            <span key={t.tag.id} className="bg-primary/10 text-primary text-[10px] px-1.5 py-0.5 rounded font-medium">{t.tag.name}</span>
                          ))}
                          {(entry.employee_splits?.length ?? 0) > 0 && (
                            <span className="inline-flex items-center gap-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] px-1.5 py-0.5 rounded font-medium">
                              <Users className="w-3 h-3" />Split × {entry.employee_splits!.length}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Date and actions */}
                    {/* Meta line: date · account on the left, actions on the right.
                        Below md the meta takes the full first line and the buttons
                        wrap beneath it, right-aligned. Sharing one line there meant
                        six action icons left about three characters for the account,
                        so "Kotak Bank" rendered as "K...".

                        Within the meta line: the date never shrinks and never wraps
                        (a two-line date was the original complaint), the account name
                        truncates rather than wrapping, and the buttons never shrink —
                        without that last rule the account grew underneath them. */}
                    <div className="flex flex-wrap justify-between items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2 min-w-0 basis-full md:basis-auto md:flex-1">
                        <span className="whitespace-nowrap tabular-nums shrink-0">
                          {isEditing ? (
                            <input type="date" value={editForm.entry_date || ''} onChange={e => setEditForm(p => ({...p, entry_date: e.target.value}))} className="bg-background border rounded px-2 py-1" />
                          ) : (
                            <span title={entry.entry_date}>{formatISODateShort(entry.entry_date)}</span>
                          )}
                        </span>
                        <span aria-hidden className="shrink-0 opacity-60">•</span>
                        <span className="truncate min-w-0">
                          {isEditing ? (
                            <select value={editForm.bank_account_id || ''} onChange={e => setEditForm(p => ({...p, bank_account_id: e.target.value}))} className="bg-background border rounded px-2 py-1">
                              <option value="">Cash</option>
                              {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                            </select>
                          ) : (
                            <span title={entry.bank_account?.name || 'Cash'}>{entry.bank_account?.name || 'Cash'}</span>
                          )}
                        </span>
                      </div>

                      <div className="flex items-center justify-end gap-1 shrink-0 ml-auto">
                        {isEditing ? (
                          <>
                            <button onClick={handleInlineSave} disabled={saving} className="p-1.5 rounded-md hover:bg-primary/20 text-primary transition-colors" title="Save changes"><Save className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setEditingRow(null)} disabled={saving} className="p-1.5 rounded-md hover:bg-secondary/80 text-muted-foreground transition-colors" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                          </>
                        ) : (
                          <>
                            {showAmounts && entry.type === 'inflow' && (
                              <button
                                onClick={() => setReceiptEntry(entry)}
                                className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                                title="Generate payment receipt"
                              >
                                <Receipt className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {isInvoice && (
                              <button
                                onClick={() => setAllocatingEntry(entry)}
                                className={`p-1.5 rounded-md hover:bg-blue-500/10 transition-colors ${allocStatus === 'fully' ? 'text-blue-500' : 'text-muted-foreground hover:text-blue-400'}`}
                                title="Manage allocations"
                              >
                                <LinkIcon className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {isSalary && (
                              <button
                                onClick={() => setAllocatingPayrollEntry(entry)}
                                className={`p-1.5 rounded-md hover:bg-violet-500/10 transition-colors ${allocStatus === 'fully' ? 'text-violet-500' : 'text-muted-foreground hover:text-violet-400'}`}
                                title="Manage salary allocations"
                              >
                                <LinkIcon className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => openDuplicateForm(entry)} className="p-1.5 rounded-md hover:bg-amber-500/10 text-muted-foreground hover:text-amber-500 transition-colors" title="Duplicate to today">
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            {!!entry.bank_account_id && (
                              <button onClick={() => handleToggleReview(entry)} className={`p-1.5 rounded-md transition-colors ${entry.is_reviewed ? 'text-green-500 hover:bg-green-500/10' : 'text-muted-foreground hover:bg-green-500/10 hover:text-green-400'}`} title={entry.is_reviewed ? "Mark as unreviewed" : "Mark as reviewed"}>
                                <CheckCircle className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => openEditForm(entry)} className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title="Edit entry (full form)">
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteConfirmId(entry.id)}
                              className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                              title="Delete entry (reversible)"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Tags — single left-aligned wrapped row */}
                    {(entry.transfer_ref || allocStatus || (entry.expense_billings || []).length > 0) && (
                      <div className="flex flex-wrap items-center gap-1 -mt-2">
                        {entry.transfer_ref && <span className="inline-flex items-center gap-1 bg-purple-500/10 text-purple-400 text-[9px] px-1.5 py-0.5 rounded font-medium"><ArrowLeftRight className="w-2.5 h-2.5" />Internal Transfer</span>}
                        {allocStatus === 'none' && <span className="inline-block bg-amber-500/10 text-amber-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Unallocated</span>}
                        {allocStatus === 'partial' && <span className="inline-block bg-blue-500/10 text-blue-400 text-[9px] px-1.5 py-0.5 rounded font-medium">Partially Allocated</span>}
                        {allocStatus === 'over' && <span className="inline-block bg-red-500/10 text-red-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Over-allocated!</span>}
                        {allocStatus === 'fully' && <span className="inline-block bg-green-500/10 text-green-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Fully Allocated</span>}
                        {(entry.expense_billings || []).map(b => (
                          <span key={b.id} className="inline-block bg-amber-500/10 text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-medium">
                            Invoiced · {b.invoice?.invoice_number || b.invoice_id.slice(0, 8)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Desktop Table View */}
          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground whitespace-nowrap w-px">Date</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Category</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Description</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Account</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Amount</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredEntries.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">No entries found</td></tr>
              )}
              {filteredEntries.map(entry => {
                const isInvoice = entry.category_id === invoiceCategoryId
                const isSalary = entry.category_id === salaryCategoryId
                
                let totalAlloc = 0
                if (isInvoice) totalAlloc = entry.allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0
                if (isSalary) totalAlloc = entry.payroll_allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0
                
                const unallocated = (entry.amount_inr || 0) - totalAlloc
                const allocStatus = (!isInvoice && !isSalary) ? null : unallocated <= 0.01 && unallocated >= -0.01 ? 'fully' : unallocated > 0.01 && totalAlloc > 0 ? 'partial' : unallocated < -0.01 ? 'over' : 'none'
                const isEditing = editingRow === entry.id

                return (
                  <tr key={entry.id} data-entry-id={entry.id} className={`hover-gradient-row group ${isEditing ? 'ring-2 ring-inset ring-primary/30 bg-primary/3' : ''}`}>
                    {/* ── Date ────────────────────────────────────────────── */}
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap tabular-nums align-top">
                      {isEditing ? (
                        <input
                          type="date"
                          value={editForm.entry_date || ''}
                          onChange={e => setEditForm(p => ({...p, entry_date: e.target.value}))}
                          className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 w-full min-w-[9rem]"
                        />
                      ) : (
                        /* `30 Aug 26`, not `2026-08-30` — the raw ISO form wraps at
                           its hyphens as soon as the column is squeezed, which put
                           every date on two lines. title= keeps the exact value one
                           hover away for anyone reconciling against a statement. */
                        <span title={entry.entry_date}>{formatISODateShort(entry.entry_date)}</span>
                      )}
                    </td>

                    {/* ── Category ────────────────────────────────────────── */}
                    <td className="px-4 py-3 align-top">
                      {isEditing ? (
                        /* Clean select — no pill wrapper so it doesn't look like a combobox */
                        <select
                          value={editForm.category_id || ''}
                          onChange={e => setEditForm(p => ({...p, category_id: e.target.value}))}
                          className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 w-full"
                        >
                          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      ) : (
                        <>
                          <div className={cn(BRANDED_PILL_BASE_CLASS, 'flex-col items-start gap-0.5')}>
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full ${entry.type === 'inflow' ? 'bg-green-400' : 'bg-red-400'}`} />
                              <span className="font-medium text-foreground">{entry.category?.name}</span>
                            </div>
                            {entry.description && (
                              <div className="text-xs text-muted-foreground opacity-70 truncate max-w-[200px] ml-3.5">
                                {entry.description}
                              </div>
                            )}
                          </div>
                          {(entry.transfer_ref || (allocStatus && allocStatus !== 'none') || allocStatus === 'none' || (entry.expense_billings || []).length > 0) && (
                            <div className="flex flex-wrap items-center gap-1 mt-1 ml-3.5">
                              {entry.transfer_ref && <span className="inline-flex items-center gap-1 bg-purple-500/10 text-purple-400 text-[9px] px-1.5 py-0.5 rounded font-medium"><ArrowLeftRight className="w-2.5 h-2.5" />Internal Transfer</span>}
                              {allocStatus === 'none'    && <span className="inline-block bg-amber-500/10  text-amber-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Unallocated</span>}
                              {allocStatus === 'partial' && <span className="inline-block bg-blue-500/10   text-blue-400  text-[9px] px-1.5 py-0.5 rounded font-medium">Partially Allocated</span>}
                              {allocStatus === 'over'    && <span className="inline-block bg-red-500/10    text-red-500   text-[9px] px-1.5 py-0.5 rounded font-medium">Over-allocated!</span>}
                              {allocStatus === 'fully'   && <span className="inline-block bg-green-500/10  text-green-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Fully Allocated</span>}
                              {(entry.expense_billings || []).map(b => (
                                <span key={b.id} className="inline-block bg-amber-500/10 text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-medium">
                                  Invoiced · {b.invoice?.invoice_number || b.invoice_id.slice(0, 8)}
                                </span>
                              ))}
                            </div>
                          )}
                          {((entry.tags?.length ?? 0) > 0 || (entry.employee_splits?.length ?? 0) > 0) && (
                            <div className="flex flex-wrap items-center gap-1 mt-1 ml-3.5">
                              {entry.tags?.map(t => (
                                <span key={t.tag.id} className="bg-primary/10 text-primary text-[9px] px-1.5 py-0.5 rounded font-medium">{t.tag.name}</span>
                              ))}
                              {(entry.employee_splits?.length ?? 0) > 0 && (
                                <span className="inline-flex items-center gap-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-medium">
                                  <Users className="w-2.5 h-2.5" />Split × {entry.employee_splits!.length}
                                </span>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </td>

                    {/* ── Description ─────────────────────────────────────── */}
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editForm.description || ''}
                          onChange={e => setEditForm(p => ({...p, description: e.target.value}))}
                          className="bg-background border border-border rounded-lg px-2 py-1.5 w-full text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                          placeholder="Description"
                        />
                      ) : (
                        entry.description || '—'
                      )}
                    </td>

                    {/* ── Account ─────────────────────────────────────────── */}
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {isEditing ? (
                        <select
                          value={editForm.bank_account_id || ''}
                          onChange={e => setEditForm(p => ({...p, bank_account_id: e.target.value}))}
                          className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 w-full"
                        >
                          <option value="">Cash</option>
                          {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      ) : (
                        entry.bank_account?.name || 'Cash'
                      )}
                    </td>

                    {/* ── Amount ──────────────────────────────────────────── */}
                    <td className={`px-4 py-3 text-right font-semibold ${entry.type === 'inflow' ? 'text-green-400' : 'text-red-400'}`}>
                      {isEditing ? (
                        <div className="flex gap-1.5 justify-end items-center">
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={editForm.amount || ''}
                            onChange={e => setEditForm(p => ({...p, amount: Number(e.target.value)}))}
                            className="bg-background border border-border rounded-lg px-2 py-1.5 w-24 text-xs text-right focus:outline-none focus:ring-2 focus:ring-primary/50"
                            placeholder="0.00"
                          />
                          <select
                            value={editForm.currency || ''}
                            onChange={e => setEditForm(p => ({...p, currency: e.target.value as Currency}))}
                            className="bg-background border border-border rounded-lg px-1.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                          >
                            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      ) : (
                        <>
                          {showAmounts ? (
                            <>
                              {entry.type === 'inflow' ? '+' : '-'}₹{(entry.amount_inr ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              {entry.currency !== 'INR' && <span className="text-xs text-muted-foreground ml-1">({entry.currency} {entry.amount?.toLocaleString()})</span>}
                            </>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </>
                      )}
                    </td>

                    {/* ── Actions ─────────────────────────────────────────── */}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {isEditing ? (
                          <>
                            <button onClick={handleInlineSave} disabled={saving} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary/15 text-primary hover:bg-primary/25 text-xs font-medium transition-colors disabled:opacity-50" title="Save changes">
                              <Save className="w-3 h-3" />Save
                            </button>
                            <button onClick={() => setEditingRow(null)} disabled={saving} className="p-1.5 rounded-lg hover:bg-secondary/80 text-muted-foreground transition-colors" title="Cancel">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            {showAmounts && entry.type === 'inflow' && (
                              <button
                                onClick={() => setReceiptEntry(entry)}
                                className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                                title="Generate payment receipt"
                              >
                                <Receipt className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {isInvoice && (
                              <button
                                onClick={() => setAllocatingEntry(entry)}
                                className={`p-1.5 rounded-md hover:bg-blue-500/10 transition-colors ${allocStatus === 'fully' ? 'text-blue-500' : allocStatus === 'none' ? 'text-amber-400 hover:text-blue-400' : 'text-muted-foreground hover:text-blue-400'}`}
                                title="Manage invoice allocations"
                              >
                                <LinkIcon className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {isSalary && (
                              <button
                                onClick={() => setAllocatingPayrollEntry(entry)}
                                className={`p-1.5 rounded-md hover:bg-violet-500/10 transition-colors ${allocStatus === 'fully' ? 'text-violet-500' : 'text-muted-foreground hover:text-violet-400'}`}
                                title="Manage salary allocations"
                              >
                                <LinkIcon className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => openDuplicateForm(entry)} className="lg:opacity-0 opacity-100 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-amber-500/10 text-muted-foreground hover:text-amber-500" title="Duplicate to today">
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                            {!!entry.bank_account_id && (
                              <button onClick={() => handleToggleReview(entry)} className={`lg:opacity-0 opacity-100 group-hover:opacity-100 transition-opacity p-1.5 rounded-md ${entry.is_reviewed ? 'text-green-500 hover:bg-green-500/10' : 'text-muted-foreground hover:bg-green-500/10 hover:text-green-400'}`} title={entry.is_reviewed ? "Mark as unreviewed" : "Mark as reviewed"}>
                                <CheckCircle className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => openEditForm(entry)} className="lg:opacity-0 opacity-100 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary" title="Edit entry (full form with FX options)">
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteConfirmId(entry.id)}
                              className="lg:opacity-0 opacity-100 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                              title="Delete entry (reversible)"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {/* Transfer Modal */}
      {showTransfer && (
        <TransferModal
          bankAccounts={bankAccounts}
          onClose={() => setShowTransfer(false)}
          onSaved={(outflow, inflow) => {
            setEntries(prev => [outflow, inflow, ...prev])
            setShowTransfer(false)
          }}
        />
      )}

      {/* Add Entry Modal */}
      {showForm && (
        <ModalOverlay onClose={() => { setShowForm(false); setFormEditingId(null) }} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div>
                <h2 className="font-semibold">{formEditingId ? 'Edit Cash Book Entry' : 'Add Cash Book Entry'}</h2>
                {formEditingId && <p className="text-[11px] text-muted-foreground mt-0.5">Invoice allocation is managed separately via the ⛓ link button</p>}
              </div>
              <button onClick={() => { setShowForm(false); setFormEditingId(null) }} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="overflow-y-auto px-6 py-5 space-y-4 flex-1 min-h-0">
              {/* Type toggle */}
              <div className="flex gap-2">
                {(['inflow', 'outflow'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setForm(p => ({ ...p, type: t, category_id: t === 'inflow' ? invoiceCategoryId : '', allocations: [], client_filter_id: '', fully_paid: false, scope: '', splitEmployeeIds: [] })); resetSmart() }}
                    className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors ${form.type === t
                      ? t === 'inflow' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'
                      : 'bg-secondary text-muted-foreground border border-transparent hover:text-foreground'
                    }`}
                  >
                    {t === 'inflow' ? '+ Income' : '- Expense'}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Category *</label>
                  <Combobox
                    options={relevantCategories.map(c => ({ id: c.id, label: c.name }))}
                    value={form.category_id}
                    onChange={id => setForm(p => {
                      // Pre-select the Books choice from the category's default
                      // scope (e.g. Rent/Software/Salary → Company).
                      const cat = categories.find(c => c.id === id)
                      return {
                        ...p,
                        category_id: id,
                        scope: cat?.default_scope === 'company' ? 'company' : '',
                        // Leaving the Invoice category hides the split editor —
                        // drop the lines rather than save them invisibly.
                        allocations: id === invoiceCategoryId ? p.allocations : [],
                      }
                    })}
                    placeholder="Select category…"
                    sortKey="cashbook_categories"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Bank Account</label>
                  <AppSelect value={form.bank_account_id} onChange={e => setForm(p => ({ ...p, bank_account_id: e.target.value }))}>
                    <option value="">Cash</option>
                    {bankAccounts.filter(b => b.is_active).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </AppSelect>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Amount *
                  {form.fully_paid && <span className="ml-2 text-green-400 font-normal">auto-filled</span>}
                </label>
                <CurrencyAmountInput
                  value={{ currency: form.currency, amount: form.amount, rate: form.rate, amountInr: form.amountInr, rateSource: form.rateSource }}
                  onChange={fx => setForm(p => ({ ...p, currency: fx.currency, amount: fx.amount, rate: fx.rate, amountInr: fx.amountInr, rateSource: fx.rateSource }))}
                  ratesMap={rateMap}
                  lockAmount={form.fully_paid}
                  rateDate={exchangeRates.find(r => r.currency === form.currency)?.rate_date}
                  onSyncRate={syncLiveRate}
                />

                {/* ── FX Gain / Loss indicator (display-only — no separate entry created) ── */}
                {fxDirection !== 'none' && (
                  <div className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${fxDirection === 'gain' ? 'border-green-500/25 bg-green-500/5' : 'border-red-500/25 bg-red-500/5'}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        {fxDirection === 'gain'
                          ? <TrendingUp  className="w-3.5 h-3.5 text-green-400 shrink-0" />
                          : <TrendingDown className="w-3.5 h-3.5 text-red-400   shrink-0" />}
                        <span className={`text-xs font-semibold ${fxDirection === 'gain' ? 'text-green-400' : 'text-red-400'}`}>
                          Realised FX {fxDirection === 'gain' ? 'Gain' : 'Loss'}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60 italic">display only</span>
                      </div>
                      <span className={`font-mono text-sm font-bold ${fxDirection === 'gain' ? 'text-green-400' : 'text-red-400'}`}>
                        {fxDirection === 'gain' ? '+' : '-'}₹{Math.abs(fxDiff).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 text-[11px] text-muted-foreground">
                      <span>At book rate (₹{fxBookRate} per {fxCalcCurrency})</span>
                      <span className="text-right font-mono">₹{fxExpectedInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                      <span>Actual ₹ received</span>
                      <span className="text-right font-mono">₹{fxActualInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Date *</label>
                  <input type="date" value={form.entry_date} onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))} required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" />
                </div>
                {!isInvoiceCategory && (
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1.5">Reference</label>
                    <input type="text" value={form.reference} onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="e.g. INV-2505-001" />
                  </div>
                )}
              </div>

              {/* ── Invoice split ──────────────────────────────────────────────
                  One receipt, any number of invoices. The client's money is
                  divided in ₹ right here, so a ₹2,750 deposit covering a ₹1,000
                  and a ₹1,750 invoice never needs a second pass through the
                  invoice page. */}
              {isInvoiceCategory && (
                <div className="rounded-xl border border-border/60 bg-foreground/[0.02] p-3 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold">Invoices</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Add every invoice this payment settles — each one takes its own share.
                      </p>
                    </div>
                    {!formEditingId && allocUnassigned > 0.01 && allocCandidates.length > 0 && (
                      <button
                        type="button"
                        onClick={autoSplitRemaining}
                        title="Spread the unallocated balance over the oldest open invoices"
                        className="shrink-0 flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-300 border border-violet-500/25 hover:bg-violet-500/25 transition-colors"
                      >
                        <Sparkles className="w-3 h-3" />
                        Split oldest first
                      </button>
                    )}
                  </div>

                  {formEditingId ? (
                    <p className="text-[11px] text-amber-500/90">
                      Invoice links aren&apos;t edited here — close this form and use the allocation
                      button (<LinkIcon className="w-3 h-3 inline-block -mt-0.5" />) on the entry row.
                    </p>
                  ) : (
                    <>
                      {/* Client filter — narrows the picker to one client's pending
                          invoices. Optional up front; the first invoice added fills
                          it in and locks every later line to the same client. */}
                      <Combobox
                        options={clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))}
                        value={form.client_filter_id}
                        onChange={id => setForm(p => ({ ...p, client_filter_id: id }))}
                        placeholder="Filter by client (optional)…"
                        disabled={form.allocations.length > 0}
                      />
                      <Combobox
                        options={allocCandidates.map(inv => {
                          const cur = inv.currency || 'INR'
                          const outstanding = inv.total_amount - (inv.paid_amount || 0)
                          const overdue = inv.due_date && inv.due_date < today
                          // Show amount in the invoice's own currency; add INR equivalent for foreign invoices
                          const totalLabel = cur === 'INR'
                            ? `₹${inv.total_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                            : `${cur} ${inv.total_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                          const outstandingLabel = cur === 'INR'
                            ? `₹${outstanding.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                            : `${cur} ${outstanding.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                          return {
                            id: inv.id,
                            label: `${overdue ? '⚠ ' : ''}${inv.invoice_number} — ${inv.client?.name}`,
                            sub: `${totalLabel} total · ${outstandingLabel} outstanding${overdue ? ' · overdue' : inv.due_date ? ` · due ${inv.due_date}` : ''}`,
                          }
                        })}
                        value=""
                        onChange={id => { if (id) addAllocation(id) }}
                        placeholder={
                          allocCandidates.length === 0
                            ? (form.allocations.length > 0 ? 'No other open invoices for this client' : 'No pending invoices for this client')
                            : form.allocations.length > 0 ? 'Add another invoice…' : 'Select invoice…'
                        }
                      />

                      {form.allocations.map(line => {
                        const inv = dueInvoices.find(i => i.id === line.invoice_id)
                        const outInr = inv ? outstandingInr(inv) : 0
                        const lineAmt = parseFloat(line.amount) || 0
                        const overLine = lineAmt > outInr + 0.01
                        return (
                          <div key={line.invoice_id} className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{inv?.invoice_number ?? 'Invoice'}</p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {inv?.client?.name}
                                {inv && ` · ₹${outInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })} outstanding`}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className="text-xs text-muted-foreground">₹</span>
                              <input
                                type="number" step="0.01" min="0" inputMode="decimal"
                                value={line.amount}
                                onChange={e => updateAllocation(line.invoice_id, e.target.value)}
                                className={`w-28 bg-secondary border rounded-lg px-2 py-1.5 text-sm text-right font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 ${overLine ? 'border-amber-500/60' : 'border-border'}`}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => removeAllocation(line.invoice_id)}
                              title="Remove from this payment"
                              className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )
                      })}

                      {form.allocations.length > 0 && (
                        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2.5 text-[11px]">
                          <span className="text-muted-foreground">
                            Entry <span className="font-mono text-foreground">₹{formAmountInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                            {' · '}Allocated <span className="font-mono text-foreground">₹{allocTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </span>
                          <span className={`font-medium shrink-0 ${allocOver ? 'text-destructive' : allocUnassigned > 0.01 ? 'text-amber-500' : 'text-green-500'}`}>
                            {allocOver
                              ? `Over by ₹${Math.abs(allocUnassigned).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
                              : allocUnassigned > 0.01
                                ? `₹${allocUnassigned.toLocaleString('en-IN', { minimumFractionDigits: 2 })} unallocated`
                                : 'Fully allocated'}
                          </span>
                        </div>
                      )}
                      {allocOver && (
                        <p className="text-[11px] text-destructive">
                          The split is larger than the entry — reduce a line, or raise the amount above.
                        </p>
                      )}
                      {form.allocations.length > 1 && allocUnassigned > 0.01 && (
                        <p className="text-[11px] text-amber-500/90">
                          The unallocated part is saved as an advance — link it later from the entry row.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Smart contextual fields */}
              {smartMode === 'credit_given' && (
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
                  <p className="text-xs font-semibold text-blue-400 uppercase tracking-wide">Credit Given — Link To</p>
                  <div className="flex gap-2">
                    {(['employee', 'client', 'other'] as const).map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setSmartExtra(p => ({ ...p, entity_type: t, entity_id: '', entity_other: '' }))}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${smartExtra.entity_type === t ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {smartExtra.entity_type === 'employee' && (
                    <Combobox
                      options={employees.map((e: any) => ({ id: e.id, label: e.cqid, sub: e.role || '' }))}
                      value={smartExtra.entity_id || ''}
                      onChange={id => {
                        const emp = employees.find((em: any) => em.id === id)
                        setSmartExtra(p => ({ ...p, entity_id: id }))
                        if (emp) setForm(p => ({ ...p, description: `Credit given to ${emp.cqid}` }))
                      }}
                      placeholder="Select employee…"
                      sortKey="employees"
                    />
                  )}
                  {smartExtra.entity_type === 'client' && (
                    <Combobox
                      options={clients.map((c: any) => ({ id: c.id, label: c.name, sub: c.code }))}
                      value={smartExtra.entity_id || ''}
                      onChange={id => {
                        const cl = clients.find((c: any) => c.id === id)
                        setSmartExtra(p => ({ ...p, entity_id: id }))
                        if (cl) setForm(p => ({ ...p, description: `Credit given to ${cl.name}` }))
                      }}
                      placeholder="Select client…"
                      sortKey="clients"
                    />
                  )}
                  {smartExtra.entity_type === 'other' && (
                    <input
                      type="text"
                      placeholder="Name / party"
                      value={smartExtra.entity_other || ''}
                      onChange={e => {
                        setSmartExtra(p => ({ ...p, entity_other: e.target.value }))
                        setForm(p => ({ ...p, description: `Credit given to ${e.target.value}` }))
                      }}
                      className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    />
                  )}
                </div>
              )}

              {smartMode === 'credit_return' && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                  <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Credit Return — Select Outstanding</p>
                  <Combobox
                    options={outstandingCredits.map((cr: any) => {
                      const outstanding = cr.amount - (cr.returned_amount || 0)
                      return {
                        id: cr.id,
                        label: `${cr.employee?.cqid || cr.entity_id} — ₹${outstanding.toLocaleString('en-IN')}`,
                        sub: `given ${cr.credit_date}`,
                      }
                    })}
                    value={smartExtra.credit_id || ''}
                    onChange={id => {
                      const cr = outstandingCredits.find((c: any) => c.id === id)
                      if (cr) {
                        const outstanding = cr.amount - (cr.returned_amount || 0)
                        setSmartExtra(p => ({ ...p, credit_id: id, entity_id: cr.entity_id, entity_type: cr.entity_type }))
                        setForm(p => ({ ...p, amount: String(outstanding), description: `Credit returned by ${cr.employee?.cqid || cr.entity_id}` }))
                      } else {
                        setSmartExtra(p => ({ ...p, credit_id: '' }))
                      }
                    }}
                    placeholder="Select outstanding credit…"
                  />
                </div>
              )}

              {smartMode === 'salary' && (() => {
                // Month labels for payslip period display. Inline rather than
                // importing dashboard-utils to keep this section self-contained.
                const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
                // Pending payslips for the currently-picked employee, already
                // sorted newest-first by the server (year desc, month desc).
                // First element = the payslip we auto-default to.
                const empPayslips = smartExtra.employee_id
                  ? pendingPayrolls.filter(p => p.employee_id === smartExtra.employee_id)
                  : []
                return (
                  <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
                    <p className="text-xs font-semibold text-purple-400 uppercase tracking-wide">Salary — Employee</p>
                    <Combobox
                      options={employees.map((e: any) => ({ id: e.id, label: e.cqid, sub: e.role || '' }))}
                      value={smartExtra.employee_id || ''}
                      onChange={id => {
                        const emp = employees.find((em: any) => em.id === id)
                        // Latest pending payslip for this employee. pendingPayrolls
                        // is server-sorted by (year desc, month desc), so .find()
                        // returns the most recent match.
                        const latest = id ? pendingPayrolls.find(p => p.employee_id === id) : null
                        setSmartExtra(p => ({ ...p, employee_id: id, payslip_id: latest?.id || '' }))
                        if (emp && latest) {
                          const amountStr = String(latest.net_salary)
                          const fx = fxFor(amountStr, 'INR')
                          setForm(p => ({
                            ...p,
                            amount: amountStr,
                            currency: 'INR',
                            ...fx,
                            reference: latest.payslip_number || '',
                            description: `Salary — ${emp.cqid} · ${MONTHS_SHORT[latest.month - 1]} ${latest.year}`,
                          }))
                        } else if (emp) {
                          // Employee with no pending payslips — clear amount/ref
                          // so the user doesn't accidentally save stale data
                          // carried over from a previously-picked employee.
                          setForm(p => ({
                            ...p,
                            amount: '',
                            amountInr: '',
                            rate: '',
                            rateSource: 'settings',
                            reference: '',
                            description: `Salary — ${emp.cqid}`,
                          }))
                        }
                      }}
                      placeholder="Select employee…"
                      sortKey="employees"
                    />
                    {smartExtra.employee_id && (
                      <Combobox
                        options={empPayslips.map(ps => ({
                          id: ps.id,
                          label: `${MONTHS_SHORT[ps.month - 1]} ${ps.year}${ps.payslip_number ? ` · ${ps.payslip_number}` : ''}`,
                          sub: `₹${ps.net_salary.toLocaleString('en-IN')} pending`,
                        }))}
                        value={smartExtra.payslip_id || ''}
                        onChange={id => {
                          const ps = pendingPayrolls.find(p => p.id === id)
                          setSmartExtra(p => ({ ...p, payslip_id: id }))
                          if (ps) {
                            const emp = employees.find((em: any) => em.id === ps.employee_id)
                            const amountStr = String(ps.net_salary)
                            const fx = fxFor(amountStr, 'INR')
                            setForm(p => ({
                              ...p,
                              amount: amountStr,
                              currency: 'INR',
                              ...fx,
                              reference: ps.payslip_number || '',
                              description: `Salary — ${emp?.cqid || ''} · ${MONTHS_SHORT[ps.month - 1]} ${ps.year}`,
                            }))
                          }
                        }}
                        placeholder={empPayslips.length === 0 ? 'No pending payslips for this employee' : 'Select payslip…'}
                      />
                    )}
                  </div>
                )
              })()}

              {smartMode === 'client_linked' && (
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
                  <p className="text-xs font-semibold text-primary uppercase tracking-wide">{selectedCat?.name} — Client</p>
                  <Combobox
                    options={clients.map((c: any) => ({ id: c.id, label: c.name, sub: c.code }))}
                    value={smartExtra.client_id || ''}
                    onChange={id => {
                      const cl = clients.find((c: any) => c.id === id)
                      setSmartExtra(p => ({ ...p, client_id: id }))
                      if (cl) setForm(p => ({ ...p, description: `${selectedCat?.name} — ${cl.name}` }))
                    }}
                    placeholder="Select client…"
                    sortKey="clients"
                  />
                </div>
              )}

              {/* Two mechanisms used to answer "this repeats": this checkbox,
                  which stamped out a fixed number of copies with no series to
                  manage afterwards, and the Recurring Expenses rules, which
                  keep posting and can be edited or paused in one place. The
                  second is strictly better, so this now points at it.

                  The fixed-copies path still exists underneath — the state and
                  the save loop are untouched — so restoring the checkbox is a
                  one-block revert if a use for it turns up. */}
              {!formEditingId && (
                <Link
                  href="/dashboard/cashbook/recurring"
                  className="flex items-center justify-between gap-2 rounded-xl border border-border/40 bg-foreground/[0.02] p-3 hover:border-violet-500/30 hover:bg-violet-500/5 transition-colors"
                >
                  <span className="min-w-0">
                    <span className="text-xs font-medium flex items-center gap-1.5">
                      <Repeat className="w-3.5 h-3.5 text-violet-500" />
                      Use Recurring Expense
                    </span>
                    <span className="block text-[10px] text-muted-foreground mt-0.5">
                      For rent, internet or subscriptions — set it once and it posts itself every month.
                    </span>
                  </span>
                  <ArrowUpRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </Link>
              )}

              {/* Everything below is optional bookkeeping detail: whose money
                  it is, spend labels, cost sharing and repeats. A normal entry
                  (type, category, amount, date, description) never needs it, so
                  it stays folded — but the header counts what is already set so
                  configured data is never hidden without a trace. */}
              {(() => {
                const advCount =
                  (form.scope && form.scope !== 'company' ? 1 : 0) +
                  (form.tags?.length ? 1 : 0)
                return (
                  <details open={advCount > 0} className="group rounded-xl border border-border bg-secondary/20">
                    <summary className="flex items-center justify-between gap-2 px-3 py-2.5 cursor-pointer select-none list-none">
                      <span className="text-xs font-medium text-foreground">
                        More options
                        <span className="text-muted-foreground font-normal ml-1.5">
                          {advCount > 0
                            ? `· ${advCount} set`
                            : '· whose money, tags, split'}
                        </span>
                      </span>
                      <ChevronDown className="w-4 h-4 text-muted-foreground group-open:rotate-180 transition-transform" />
                    </summary>
                    <div className="px-3 pb-3 space-y-4">
              {/* ── Books — which economy this money belongs to. Hidden when a
                   client is tagged (client money by definition). ── */}
              {!(smartExtra.client_id || form.client_filter_id) && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Whose money is this?</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setForm(p => ({ ...p, scope: 'company' }))}
                      className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${form.scope === 'company'
                        ? 'bg-primary/15 text-primary border-primary/30'
                        : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}
                    >
                      Company (Cirqle)
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm(p => ({ ...p, scope: '' }))}
                      className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors border ${form.scope === ''
                        ? 'bg-primary/15 text-primary border-primary/30'
                        : 'bg-secondary text-muted-foreground border-transparent hover:text-foreground'}`}
                    >
                      Client — tag later
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Company entries feed the Company P&L. “Tag later” keeps it in the triage queue until a client is linked.
                  </p>
                </div>
              )}

              {/* ── Tags — free-form spend labels ("Photoshop", "Design", …)
                   for the Cost & Tags report, independent of category. ── */}
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Tags</label>
                <TagPicker
                  availableTags={allTags}
                  value={form.tags}
                  onChange={tags => setForm(p => ({ ...p, tags }))}
                  placeholder="e.g. Photoshop, Design…"
                />
              </div>

              {/* ── Employee cost split — one expense shared across employees
                   (e.g. one Photoshop seat for two designers), divided equally.
                   Outflow-only: an inflow has no "cost" to attribute. ── */}
              {form.type === 'outflow' && (
                <div className="rounded-xl border border-border/60 bg-foreground/[0.02] p-3 space-y-2.5">
                  <label className="block text-xs font-medium text-muted-foreground">
                    Split across employees <span className="text-muted-foreground/60 font-normal">(optional — divides the cost equally)</span>
                  </label>
                  <FilterDropdown
                    options={employees.map((e: any) => ({ value: e.id, label: maskEmployee(e) }))}
                    value=""
                    onChange={() => {}}
                    placeholder={form.splitEmployeeIds.length > 0 ? `${form.splitEmployeeIds.length} employee${form.splitEmployeeIds.length === 1 ? '' : 's'} selected` : 'Select employees…'}
                    multiple
                    values={form.splitEmployeeIds}
                    onToggle={id => setForm(p => ({
                      ...p,
                      splitEmployeeIds: p.splitEmployeeIds.includes(id)
                        ? p.splitEmployeeIds.filter(x => x !== id)
                        : [...p.splitEmployeeIds, id],
                    }))}
                    onClear={() => setForm(p => ({ ...p, splitEmployeeIds: [] }))}
                  />
                  {splitPreview.length > 0 && (
                    <div className="space-y-1 pt-1">
                      {splitPreview.map(s => {
                        const emp = employees.find((e: any) => e.id === s.employeeId)
                        return (
                          <div key={s.employeeId} className="flex items-center justify-between text-xs">
                            <span className="text-muted-foreground">{maskEmployee(emp)}</span>
                            <span className="font-medium tabular-nums">₹{s.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
                <input type="text" value={form.description} onChange={e => { setDescTouched(true); setForm(p => ({ ...p, description: e.target.value })) }} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="What is this for?" />
              </div>

              {/* Recurring entry — hidden when editing an existing entry */}


                    </div>
                  </details>
                )
              })()}

              </div>
              <div className="flex gap-3 px-6 py-4 border-t border-border shrink-0 bg-card pb-[max(1rem,env(safe-area-inset-bottom))]">
                <button type="button" onClick={() => { setShowForm(false); setFormEditingId(null); setRecurringMonths(0) }} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
                <button type="submit" disabled={saving || allocOver} className={`flex-1 text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 ${form.type === 'inflow' ? 'bg-green-600' : 'bg-red-600'}`}>
                  {saving
                    ? 'Saving…'
                    : formEditingId
                      ? 'Update Entry'
                      : recurringMonths > 0
                        ? `Save ${recurringMonths + 1} Entries`
                        : `Save ${form.type === 'inflow' ? 'Income' : 'Expense'}`}
                </button>
              </div>
            </form>
          </div>
        </ModalOverlay>
      )}

      {/* Allocation Modal */}
      {allocatingEntry && (
        <AllocationModal
          entryId={allocatingEntry.id}
          entryDate={allocatingEntry.entry_date}
          entryClientId={allocatingEntry.client_id}
          amountInr={allocatingEntry.amount_inr || 0}
          entryCurrency={(allocatingEntry.currency as any) || 'INR'}
          entryForeignAmount={allocatingEntry.amount ?? 0}
          entryBookRate={rateMap[(allocatingEntry.currency as string) || 'INR'] || 0}
          dueInvoices={sortedDueInvoices}
          onClose={() => setAllocatingEntry(null)}
          onUpdate={() => router.refresh()}
        />
      )}
      {allocatingPayrollEntry && (
        <PayrollAllocationModal
          entryId={allocatingPayrollEntry.id}
          amountInr={allocatingPayrollEntry.amount_inr || 0}
          employees={employees}
          reference={allocatingPayrollEntry.reference}
          onClose={() => setAllocatingPayrollEntry(null)}
          onUpdate={() => window.location.reload()}
        />
      )}

      {/* Payment Receipt (4:5 shareable image / PDF) */}
      {receiptEntry && (
        <ReceiptModal
          input={((): ReceiptInput => {
            const allocs = (receiptEntry.allocations || []).filter(a => !a.deleted_at)
            
            // Helper to handle Supabase returning an array or object for a relation
            const unwrap = (obj: any) => (Array.isArray(obj) ? obj[0] : obj)
            
            // allocated_amount is always ₹; the receipt is drawn in the entry's
            // own currency, so convert with the entry's own rate (1 for INR).
            const inrToEntryCcy = (receiptEntry.amount_inr || 0) > 0
              ? (receiptEntry.amount ?? 0) / (receiptEntry.amount_inr as number)
              : 1

            // Build the list of invoices for the receipt. Fallback to the direct_invoice if there are no allocations.
            let receiptInvoices = allocs.map(a => {
              const inv = unwrap(a.invoice)
              return {
                number: inv?.invoice_number || '—',
                outstanding: inv ? Number(inv.total_amount) - Number(inv.paid_amount || 0) : 0,
                // Each invoice's share — itemised on the receipt for split payments.
                allocated: round2(Number(a.allocated_amount || 0) * inrToEntryCcy),
              }
            })
            
            const firstClient = allocs.find(a => unwrap(unwrap(a.invoice)?.client)?.name)
            let firstClientId = firstClient ? unwrap(unwrap(firstClient.invoice)?.client)?.id : undefined
            let firstClientName = firstClient ? unwrap(unwrap(firstClient.invoice)?.client)?.name : ''
            
            if (receiptInvoices.length === 0 && receiptEntry.direct_invoice) {
              const directInv = unwrap(receiptEntry.direct_invoice)
              receiptInvoices = [{
                number: directInv?.invoice_number || '—',
                outstanding: directInv ? Number(directInv.total_amount) - Number(directInv.paid_amount || 0) : 0,
                allocated: receiptEntry.amount ?? 0,
              }]
              firstClientId = unwrap(directInv?.client)?.id || undefined
              firstClientName = unwrap(directInv?.client)?.name || ''
            }

            // Calculate total outstanding balance across all unpaid invoices for this customer
            let customerTotalOutstanding: number | undefined = undefined
            const clientId = receiptEntry.client_id || firstClientId
            if (clientId) {
              const clientInvoices = dueInvoices.filter(i => 
                (i.client?.id === clientId || i.client_id === clientId) && 
                i.currency === receiptEntry.currency
              )
              customerTotalOutstanding = clientInvoices.reduce((sum, inv) => sum + Math.max(0, Number(inv.total_amount) - Number(inv.paid_amount || 0)), 0)
            }

            // inflow entries). The UUID-derived fallback covers only outflow
            // entries opened via the receipt icon, or any entry created before
            // migration 011 was applied to this environment.
            const compact = (receiptEntry.entry_date || '').replace(/-/g, '')
            const legacyNo = `RCPT-${compact}-${receiptEntry.id.slice(-4).toUpperCase()}`
            return {
              receiptNo: receiptEntry.receipt_number || legacyNo,
              defaultClientName: firstClientName || '',
              amount: receiptEntry.amount ?? receiptEntry.amount_inr ?? 0,
              currency: receiptEntry.currency,
              dateISO: receiptEntry.entry_date,
              method: receiptEntry.bank_account?.name,
              reference: receiptEntry.reference,
              invoices: receiptInvoices,
              customerTotalOutstanding,
              // Branding from Settings → Company. Missing keys leave the
              // receipt rendering its built-in Cirqle defaults.
              // Receipt has a dark background — use dark logo when available,
              // fall back to the light/default logo otherwise.
              companyLogoUrl: resolveBrandingUrl(companySettings.logo_url_dark || companySettings.logo_url),
              companyName:    companySettings.company_name,
              companyPhone:   companySettings.company_phone,
              companyWebsite: companySettings.company_website,
            }
          })()}
          onClose={() => setReceiptEntry(null)}
        />
      )}


      {/* FX Gain/Loss Report Modal (opt-in) */}
      {showFxReportModal && (
        <ModalOverlay onClose={() => setShowFxReportModal(false)} sheetOnMobile>
          <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-2xl shadow-2xl max-h-[90dvh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div>
                <h2 className="font-semibold">FX Gain/Loss Report</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">Historical exchange rate analysis · display only</p>
              </div>
              <button onClick={() => setShowFxReportModal(false)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-4">
              {/* Month / Year toggle */}
              <div className="flex gap-1.5">
                {(['month', 'year'] as const).map(v => (
                  <button key={v} type="button" onClick={() => setFxPeriodView(v)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${fxPeriodView === v ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground border border-border'}`}>
                    {v === 'month' ? 'By Month' : 'By Year'}
                  </button>
                ))}
              </div>

              {/* Summary Card */}
              <div className={`rounded-lg border ${realisedFxGainLoss > 0 ? 'border-green-500/25 bg-green-500/5' : 'border-red-500/25 bg-red-500/5'} p-4`}>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    {realisedFxGainLoss > 0
                      ? <TrendingUp className="w-4 h-4 text-green-400 shrink-0" />
                      : <TrendingDown className="w-4 h-4 text-red-400 shrink-0" />}
                    <span className={`text-sm font-semibold ${realisedFxGainLoss > 0 ? 'text-green-400' : 'text-red-400'}`}>
                      Total FX {realisedFxGainLoss > 0 ? 'Gain' : 'Loss'}
                    </span>
                  </div>
                  <span className={`text-lg font-bold font-mono ${realisedFxGainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {realisedFxGainLoss >= 0 ? '+' : ''}₹{realisedFxGainLoss.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>

              {/* Table — expand/collapse with nested multi-line detail rows,
                  not converted to mobile cards (deep admin report, not a
                  primary workflow; the interaction is riskier to replicate
                  than a plain data table). overflow-x-auto confines any
                  needed scroll to the table itself instead of it forcing the
                  whole modal to overflow horizontally. */}
              <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[420px]">
                <thead>
                  <tr className="text-muted-foreground border-b border-border">
                    <th className="text-left pb-2 font-medium w-8"></th>
                    <th className="text-left pb-2 font-medium">{fxPeriodView === 'month' ? 'Month' : 'Year'}</th>
                    <th className="text-right pb-2 font-medium">Entries</th>
                    <th className="text-right pb-2 font-medium">FX Gain / Loss</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {(fxPeriodView === 'month' ? fxByMonth : fxByYear).map(row => {
                    const periodKey = fxPeriodView === 'month' ? (row as any).period : (row as any).year
                    const isExpanded = fxExpandedRow === periodKey
                    return (
                      <>
                        <tr key={`${periodKey}-header`}
                            onClick={() => setFxExpandedRow(isExpanded ? null : periodKey)}
                            className="hover:bg-secondary/20 transition-colors cursor-pointer">
                          <td className="py-2 pl-2">
                            <svg className={`w-4 h-4 text-muted-foreground transition-transform inline ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                          </td>
                          <td className="py-2 font-medium">
                            {fxPeriodView === 'month' ? (row as any).label : (row as any).year}
                          </td>
                          <td className="py-2 text-right text-muted-foreground">{row.count}</td>
                          <td className={`py-2 text-right font-mono font-semibold ${row.fxDiff >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {row.fxDiff >= 0 ? '+' : ''}₹{row.fxDiff.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </td>
                        </tr>
                        {isExpanded && row.entries.map((entry, idx) => (
                          <tr key={`${periodKey}-entry-${idx}`} className="bg-secondary/10">
                            <td className="py-2 pl-6"></td>
                            <td className="py-2 space-y-0.5">
                              <div className="font-medium text-foreground">{entry.clientName || '—'}</div>
                              <div className="text-muted-foreground text-[10px]">
                                {entry.invoiceNumber ? `Inv: ${entry.invoiceNumber}` : 'No invoice'} • {entry.entryDate}
                              </div>
                            </td>
                            <td className="py-2 text-right">
                              <div className="text-foreground">{entry.foreignAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} {entry.currency}</div>
                              <div className="text-muted-foreground text-[10px]">Book: ₹{entry.bookValueInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                            </td>
                            <td className="py-2 text-right">
                              <div className="text-foreground">₹{entry.actualInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
                              <div className={`font-mono text-[10px] font-semibold ${entry.fxDiff >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                {entry.fxDiff >= 0 ? '+' : ''}₹{Math.abs(entry.fxDiff).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </>
                    )
                  })}
                </tbody>
                <tfoot className="border-t border-border">
                  <tr>
                    <td className="pt-2"></td>
                    <td className="pt-2 text-muted-foreground font-medium">Total</td>
                    <td className="pt-2 text-right text-muted-foreground">{fxByMonth.reduce((s, m) => s + m.count, 0)}</td>
                    <td className={`pt-2 text-right font-mono font-bold ${realisedFxGainLoss >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {realisedFxGainLoss >= 0 ? '+' : ''}₹{realisedFxGainLoss.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                </tfoot>
              </table>
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}

      {deleteConfirmId && (
        <ConfirmDialog
          title="Delete this entry?"
          body="The entry is hidden from the Cash Book and its balances. It can be restored from the Reconciliation Toolkit."
          confirmLabel="Delete entry"
          danger
          onConfirm={() => { const id = deleteConfirmId; setDeleteConfirmId(null); void handleSoftDelete(id) }}
          onCancel={() => setDeleteConfirmId(null)}
        />
      )}
    </div>
  )
}
