'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useCopy } from '@/lib/hooks/use-copy'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import {
  getStatusColor, getStatusLabel, isOverdue,
  isEditable, formatBillingPeriod, getNextAction,
} from '@/lib/utils/invoice'
import { formatCurrency } from '@/lib/calculations/currency'
import {
  FileText, Plus, X, ChevronRight, CheckCircle, Send, CreditCard,
  Trash2, AlertTriangle, Clock, Eye, Lock, Zap, Download, RefreshCw,
  Calendar, Building2, IndianRupee, MoreHorizontal, Search, Filter,
  Printer, TrendingUp, BadgeCheck, CircleDollarSign, Receipt, Edit2, Save,
  History, Tag, Percent, ChevronDown, ChevronUp, ArrowDownToLine, Gift, ExternalLink, Copy,
} from 'lucide-react'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import { FilterDropdown } from '@/components/ui/filter-dropdown'
import { useToast, ToastContainer } from '@/components/ui/toast'
import { useRole } from '@/contexts/role-context'
import type { Currency } from '@/types'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ClientEditModal } from '@/components/ui/client-edit-modal'

// ─── Types ────────────────────────────────────────────────────────────────────
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
  id: string; amount: number; payment_date: string
  payment_method: string; reference?: string; notes?: string
}
interface Invoice {
  id: string; invoice_number: string; client_id: string
  status: string; issue_date: string; due_date?: string
  billing_period_start?: string; billing_period_end?: string
  currency: Currency; total_amount: number; paid_amount: number
  subtotal: number; tax_rate: number; tax_amount: number
  discount_amount: number; previous_balance: number
  notes?: string; created_at: string; updated_at: string
  client?: { id: string; name: string; code: string; phone?: string; email?: string; address?: string }
  items?: InvoiceItem[]
  payments?: Payment[]
}

interface Props {
  initialInvoices: Invoice[]
  clients: { id: string; name: string; code: string; phone?: string; email?: string; address?: string; default_currency?: string }[]
  bankAccounts: { id: string; name: string }[]
  services: { id: string; name: string }[]
  companySettings: Record<string, string>
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
function fmt(n: number, currency: Currency = 'INR') {
  return formatCurrency(n, currency)
}
function fmtDate(d?: string) {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })
}
function balanceDue(inv: Invoice) {
  return Math.max(0, (inv.total_amount || 0) - (inv.paid_amount || 0))
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function InvoicesClient({ initialInvoices, clients, bankAccounts, services, companySettings }: Props) {
  const supabase = createClient()
  const { toasts, dismiss, success, error: toastError } = useToast()
  const { role } = useRole()
  const [copiedInvNum, copyInvNum] = useCopy()

  // ── State ──────────────────────────────────────────────────────────────────
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices.map(inv => ({
    ...inv,
    subtotal: inv.subtotal ?? inv.total_amount ?? 0,
    tax_rate: inv.tax_rate ?? 0,
    tax_amount: inv.tax_amount ?? 0,
    discount_amount: inv.discount_amount ?? 0,
    previous_balance: inv.previous_balance ?? 0,
  })))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterClient, setFilterClient] = useState<string>('')
  const [searchQ, setSearchQ] = useState('')
  const [tab, setTab] = useState<'active' | 'closed'>('active')
  const [editClientId, setEditClientId] = useState<string | null>(null)

  // Panel modes
  const [panelMode, setPanelMode] = useState<'detail' | 'pay' | 'new' | 'generate' | 'statement' | 'discounts'>('detail')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Confirmation modal
  const [confirmModal, setConfirmModal] = useState<{
    title: string; body: string; confirmLabel: string; danger?: boolean; onConfirm: () => void
  } | null>(null)

  // Payment form
  const [payForm, setPayForm] = useState({
    amount: '', payment_date: new Date().toISOString().split('T')[0],
    payment_method: 'bank_transfer', reference: '', notes: '', bank_account_id: '',
  })

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
  const [analyticsTab, setAnalyticsTab] = useState<'discounts' | 'bad_debts' | 'overdue' | 'advances' | 'job_losses'>('discounts')
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

  // Invoice preview modal
  const [previewInv, setPreviewInv] = useState<Invoice | null>(null)

  // Statement generator
  const [stmtDetailed, setStmtDetailed] = useState(false)
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

  const filtered = useMemo(() => {
    let list = invoices.filter(inv => {
      const inTab = tab === 'active'
        ? STATUS_GROUPS.active.includes(inv.status) || (isOverdue(inv.due_date || '', inv.status) && inv.status !== 'paid')
        : STATUS_GROUPS.closed.includes(inv.status)
      if (!inTab) return false
      if (filterStatus && inv.status !== filterStatus) return false
      if (filterClient && inv.client_id !== filterClient) return false
      if (searchQ) {
        const q = searchQ.toLowerCase()
        if (!inv.invoice_number.toLowerCase().includes(q) &&
            !inv.client?.name.toLowerCase().includes(q)) return false
      }
      return true
    })
    // Sort: drafts first (newest period), then by created_at desc
    return list.sort((a, b) => {
      const ai = STATUS_PIPELINE.indexOf(a.status)
      const bi = STATUS_PIPELINE.indexOf(b.status)
      if (ai !== bi) return ai - bi
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    })
  }, [invoices, tab, filterStatus, filterClient, searchQ])

  // Summary stats
  const stats = useMemo(() => {
    const active = invoices.filter(i => !['paid', 'cancelled', 'bad_debt'].includes(i.status))
    const drafts = invoices.filter(i => i.status === 'draft')
    const overdue = invoices.filter(i => isOverdue(i.due_date || '', i.status))
    return {
      outstanding: active.reduce((s, i) => s + balanceDue(i), 0),
      overdueAmt: overdue.reduce((s, i) => s + balanceDue(i), 0),
      draftCount: drafts.length,
      draftTotal: drafts.reduce((s, i) => s + (i.total_amount || 0), 0),
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

    // When reverting to draft, free tasks back to done
    if (newStatus === 'draft') {
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
    setInvoices(prev => prev.map(i => i.id === invoiceId ? { ...i, discount_amount: amt, total_amount: newTotal } : i))
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
      ? { ...i, discount_amount: discount, total_amount: total }
      : i
    ))
  }

  async function handlePayment(invoiceId: string) {
    const amt = parseFloat(payForm.amount)
    if (!amt || amt <= 0) { toastError('Enter a valid amount'); return }
    const inv = invoices.find(i => i.id === invoiceId)
    if (!inv) return
    setSaving(true)

    const noteText = [
      isAdvancePayment ? '[ADVANCE PAYMENT]' : null,
      payForm.notes || null,
    ].filter(Boolean).join(' — ') || null

    const { data: pmt, error } = await supabase.from('payments').insert({
      invoice_id: invoiceId, amount: amt, payment_date: payForm.payment_date,
      payment_method: payForm.payment_method, reference: payForm.reference || null,
      notes: noteText, bank_account_id: payForm.bank_account_id || null,
    }).select().single()

    if (error) { toastError(error.message); setSaving(false); return }

    const newPaid = (inv.paid_amount || 0) + amt
    const balance = (inv.total_amount || 0) - newPaid
    // Advance payments may exceed total — keep as 'partial' in that case, don't flip to 'paid' on accident
    const newStatus = isAdvancePayment
      ? (balance <= 0 ? 'paid' : 'partial')
      : (balance <= 0 ? 'paid' : 'partial')

    await supabase.from('invoices').update({ paid_amount: newPaid, status: newStatus }).eq('id', invoiceId)
    const prevPaid = inv.paid_amount || 0
    const prevStatus = inv.status
    setInvoices(prev => prev.map(i => i.id === invoiceId
      ? { ...i, paid_amount: newPaid, status: newStatus, payments: [...(i.payments || []), pmt] }
      : i
    ))
    const label = isAdvancePayment ? `Advance ${fmt(amt)} recorded` : `Payment of ${fmt(amt)} recorded`
    success(label, undefined, 5000, {
      label: 'Undo',
      onClick: async () => {
        await supabase.from('payments').delete().eq('id', pmt.id)
        await supabase.from('invoices').update({ paid_amount: prevPaid, status: prevStatus }).eq('id', invoiceId)
        setInvoices(prev => prev.map(i => i.id === invoiceId
          ? { ...i, paid_amount: prevPaid, status: prevStatus, payments: (i.payments || []).filter(p => p.id !== pmt.id) }
          : i
        ))
      },
    })
    setPayForm({ amount: '', payment_date: new Date().toISOString().split('T')[0], payment_method: 'bank_transfer', reference: '', notes: '', bank_account_id: '' })
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
    const inv = invoices.find(i => i.id === invoiceId)
    const taskIds = (inv?.items || []).map(it => it.task_id).filter(Boolean) as string[]
    if (taskIds.length) await supabase.from('tasks').update({ status: 'done' }).in('id', taskIds)
    await supabase.from('invoice_items').delete().eq('invoice_id', invoiceId)
    await supabase.from('payments').delete().eq('invoice_id', invoiceId)
    await supabase.from('invoices').delete().eq('id', invoiceId)
    setInvoices(prev => prev.filter(i => i.id !== invoiceId))
    if (selectedId === invoiceId) setSelectedId(null)
    success('Invoice deleted')
    setDeleting(false)
  }

  // Keep ref in sync so Cmd+S can call it
  const createManualInvoice = useCallback(async function createManualInvoiceImpl() {
    if (!newForm.client_id) { toastError('Select a client'); return }
    setSaving(true)
    const client = clients.find(c => c.id === newForm.client_id)
    const d = new Date(newForm.issue_date)
    const yy = String(d.getFullYear()).slice(-2)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const baseNum = `INV-${yy}${mm}-${client?.code || 'CLI'}`

    // Check DB for existing numbers with this prefix (avoids conflicts with auto-generated invoices)
    const { data: existingNums } = await supabase
      .from('invoices').select('invoice_number').like('invoice_number', `${baseNum}%`)
    const takenNums = new Set((existingNums || []).map((r: any) => r.invoice_number))
    let invNum = baseNum
    let suffix = 2
    while (takenNums.has(invNum)) {
      invNum = `${baseNum}-${suffix++}`
    }

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
      .select('id, title, task_date, billing_amount_inr, currency, status, service:services(name)')
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
    const d      = new Date(from)
    const yy     = String(d.getFullYear()).slice(-2)
    const mm     = String(d.getMonth() + 1).padStart(2, '0')
    const dd2    = String(d.getDate()).padStart(2, '0')

    const baseNum = genForm.mode === 'day'
      ? `INV-${yy}${mm}${dd2}-${client?.code || 'CLI'}`
      : `INV-${yy}${mm}-${client?.code || 'CLI'}`

    // Check DB for existing numbers (avoids conflicts with auto-generated drafts)
    const { data: takenNums$ } = await supabase
      .from('invoices').select('invoice_number').like('invoice_number', `${baseNum}%`)
    const takenNums = new Set((takenNums$ || []).map((r: any) => r.invoice_number))
    let invNum = baseNum; let suffix = 2
    while (takenNums.has(invNum)) invNum = `${baseNum}-${suffix++}`

    const subtotal = selected.reduce((s, t) => s + (t.billing_amount_inr || 0), 0)
    // Base insert — columns that always exist
    const { data: inv, error } = await supabase.from('invoices').insert({
      invoice_number: invNum, client_id: genForm.client_id, status: 'draft',
      issue_date: new Date().toISOString().split('T')[0],
      total_amount: subtotal, paid_amount: 0,
      currency: client?.default_currency || 'INR',
    }).select('*, client:clients(id,name,code,phone,email,address)').single()

    if (error) { toastError(error.message); setSaving(false); return }

    // Update extended columns if migration has been run (ignore error if columns don't exist yet)
    await supabase.from('invoices').update({
      billing_period_start: from, billing_period_end: to,
      subtotal, tax_rate: 0, tax_amount: 0, discount_amount: 0, previous_balance: 0,
    }).eq('id', inv.id)

    await supabase.from('invoice_items').insert(
      selected.map((t, idx) => ({
        invoice_id: inv.id, task_id: t.id,
        description: t.title, quantity: 1,
        unit_price: t.billing_amount_inr, total: t.billing_amount_inr,
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
    const logoUrl = companySettings.logo_url              || ''
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
    function inr(n: number) {
      return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
    function inr(n: number) {
      return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
        runningBalance -= pmt.amount
        const methodLabels: Record<string, string> = { bank_transfer: 'Bank Transfer', cash: 'Cash', upi: 'UPI', cheque: 'Cheque', online: 'Online', other: 'Other' }
        allRows += `
          <tr style="background:#f0fff4">
            <td style="padding:5px 10px 5px 24px;border-bottom:1px solid #c3e6cb;font-size:11px;color:#27ae60">✓ Payment received</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;font-size:11px;color:#888;white-space:nowrap">${dd(pmt.payment_date)}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;font-size:11px;color:#888">${methodLabels[pmt.payment_method] || pmt.payment_method}${pmt.reference ? ' · ' + pmt.reference : ''}</td>
            <td style="padding:5px 10px;border-bottom:1px solid #c3e6cb;text-align:right;font-size:11px;color:#27ae60">−${inr(pmt.amount)}</td>
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

  async function loadDiscountAnalytics() {
    if (discAnalyticsLoaded) return
    setDiscAnalyticsLoading(true)
    const { data } = await supabase
      .from('discount_logs')
      .select('*, invoice:invoices(invoice_number, total_amount, status), client:clients(id, name, code)')
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

  async function refreshInvoice(invoiceId: string) {
    const { data } = await supabase.from('invoices')
      .select('*, client:clients(id,name,code,phone,email), items:invoice_items(*, task:tasks(id,title,task_date,status,billing_amount_inr,currency), service:services(id,name)), payments(*)')
      .eq('id', invoiceId).single()
    if (data) setInvoices(prev => prev.map(i => i.id === invoiceId ? data as any : i))
  }

  function buildInvoiceHtml(inv: Invoice): string {
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
      logoUrl: companySettings.logo_url        || '',
      footerText: companySettings.invoice_footer_text || 'Thank you for your Business!',
    }
    const showLogo       = companySettings.invoice_show_logo        !== 'false'
    const showTagline    = companySettings.invoice_show_tagline     !== 'false'
    const showPayInfo    = companySettings.invoice_show_payment_info !== 'false'
    const showContact    = companySettings.invoice_show_phone       !== 'false'

    const NAVY       = companySettings.invoice_primary_color || '#1a2744'
    const NAVY_LIGHT = companySettings.invoice_accent_color  || '#243459'
    const FONT       = companySettings.invoice_font          || 'Arial, Helvetica, sans-serif'
    const sortedItems = [...(inv.items || [])].sort((a, b) => a.display_order - b.display_order)
    const subtotal = inv.subtotal || inv.total_amount || 0
    const prevBal  = inv.previous_balance || 0
    const totalDue = subtotal + prevBal
    const discount = inv.discount_amount || 0
    const taxAmt   = inv.tax_amount || 0
    const totalPayable = totalDue + taxAmt - discount

    // Format date as DD/MM/YYYY
    function dd(d?: string) {
      if (!d) return ''
      const dt = new Date(d + 'T00:00:00')
      return `${String(dt.getDate()).padStart(2,'0')}/${String(dt.getMonth()+1).padStart(2,'0')}/${dt.getFullYear()}`
    }
    function inr(n: number) {
      return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    // Build table rows
    const itemRows = sortedItems.map((it, idx) => {
      const taskDate = it.task?.task_date ? dd(it.task.task_date) : ''
      const bg = idx % 2 === 0 ? '#f7f9fc' : '#ffffff'
      return `
        <tr style="background:${bg}">
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;text-align:center;color:#555;font-size:12px">${idx + 1}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;color:#555;font-size:12px;white-space:nowrap">${taskDate}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;font-size:12px">${it.description}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;text-align:center;font-size:12px">${it.quantity}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;text-align:right;font-size:12px">${inr(it.unit_price)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf5;text-align:right;font-size:12px;font-weight:600">${inr(it.total)}</td>
        </tr>`
    }).join('')

    const upiString = co.upi ? `upi://pay?pa=${co.upi}&pn=${encodeURIComponent(co.holder)}&cu=INR` : ''

    // Logo: use uploaded image if available, else SVG icon
    const logoBlock = showLogo
      ? co.logoUrl
        ? `<img src="${co.logoUrl}" alt="logo" style="height:44px;object-fit:contain;display:block"/>`
        : `<svg width="42" height="42" viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg">
             <circle cx="21" cy="21" r="20" fill="none" stroke="${NAVY}" stroke-width="2.5"/>
             <circle cx="21" cy="21" r="14" fill="${NAVY}"/>
             <text x="21" y="26" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">c</text>
           </svg>`
      : ''

    // Footer logo (small)
    const footerLogoBlock = co.logoUrl
      ? `<img src="${co.logoUrl}" alt="logo" style="height:20px;object-fit:contain;display:inline-block;vertical-align:middle"/>`
      : `<svg width="18" height="18" viewBox="0 0 42 42" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle">
           <circle cx="21" cy="21" r="20" fill="none" stroke="${NAVY}" stroke-width="2.5"/>
           <circle cx="21" cy="21" r="14" fill="${NAVY}"/>
           <text x="21" y="26" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">c</text>
         </svg>`

    const paymentBlock = showPayInfo && (co.holder || co.account || co.upi) ? `
      <div style="margin-top:4px">
        <div style="font-weight:700;font-size:12px;color:${NAVY};margin-bottom:6px">Payment Information</div>
        <table style="border-collapse:collapse;width:100%">
          ${co.holder  ? `<tr><td style="font-size:11px;color:#666;padding:2px 0;white-space:nowrap">A/C Holder Name</td><td style="padding:2px 8px;font-size:11px;color:#333">:</td><td style="font-size:11px;font-weight:600;color:${NAVY};text-transform:uppercase">${co.holder}</td></tr>` : ''}
          ${co.account ? `<tr><td style="font-size:11px;color:#666;padding:2px 0;white-space:nowrap">A/C Number</td><td style="padding:2px 8px;font-size:11px;color:#333">:</td><td style="font-size:11px;font-weight:600;color:${NAVY}">${co.account}</td></tr>` : ''}
          ${co.ifsc    ? `<tr><td style="font-size:11px;color:#666;padding:2px 0;white-space:nowrap">IFSC Code</td><td style="padding:2px 8px;font-size:11px;color:#333">:</td><td style="font-size:11px;font-weight:600;color:${NAVY}">${co.ifsc}</td></tr>` : ''}
          ${co.upi     ? `<tr><td style="font-size:11px;color:#666;padding:2px 0;white-space:nowrap">UPI ID</td><td style="padding:2px 8px;font-size:11px;color:#333">:</td><td style="font-size:11px;font-weight:600;color:${NAVY}">${co.upi}</td></tr>` : ''}
        </table>
        ${upiString ? `<div style="margin-top:10px;font-size:10px;color:#888">Scan to pay via UPI:<br/><span style="font-family:monospace;font-size:9px;word-break:break-all">${co.upi}</span></div>` : ''}
      </div>` : ''

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>${inv.invoice_number}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box }
    body { font-family: ${FONT}; color: #222; background:#fff; font-size:13px }
    @page { margin: 15mm 12mm; size: A4 portrait }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact } }
  </style>
</head>
<body style="padding:24px 28px;max-width:800px;margin:0 auto">

  <!-- ── HEADER ── -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    <tr>
      <td style="vertical-align:top;width:60%">
        <!-- Logo + Company name -->
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          ${logoBlock}
          <div>
            <div style="font-size:22px;font-weight:900;color:${NAVY};letter-spacing:-0.5px;line-height:1">${co.name}</div>
            ${showTagline ? `<div style="font-size:10px;color:#666;font-weight:600;letter-spacing:1px;text-transform:uppercase">${co.tagline}</div>` : ''}
          </div>
        </div>
        ${showContact && (co.phone || co.website) ? `
        <div style="font-size:11px;color:#555;margin-top:4px;line-height:1.7">
          ${co.phone ? `📞 ${co.phone}` : ''}
          ${co.website ? `&nbsp;&nbsp;🌐 ${co.website}` : ''}
        </div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right;width:40%">
        <div style="font-size:34px;font-weight:900;color:${NAVY};letter-spacing:2px;text-transform:uppercase;line-height:1">INVOICE</div>
      </td>
    </tr>
  </table>

  <!-- ── DIVIDER ── -->
  <div style="height:3px;background:linear-gradient(90deg,${NAVY} 0%,${NAVY_LIGHT} 60%,#e0e7f0 100%);border-radius:2px;margin-bottom:14px"></div>

  <!-- ── BILL TO + INVOICE META ── -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    <tr>
      <td style="vertical-align:top;width:55%">
        <div style="font-size:10px;font-weight:700;color:${NAVY};letter-spacing:1px;text-transform:uppercase;margin-bottom:4px">Bill To</div>
        <div style="font-size:14px;font-weight:700;color:${NAVY}">${inv.client?.name || ''}</div>
        ${inv.client?.address ? `<div style="font-size:11px;color:#555;margin-top:2px;line-height:1.5">${inv.client.address}</div>` : ''}
        ${inv.client?.phone   ? `<div style="font-size:11px;color:#555;margin-top:2px">${inv.client.phone}</div>` : ''}
        ${inv.client?.email   ? `<div style="font-size:11px;color:#555">${inv.client.email}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right;width:45%">
        <table style="border-collapse:collapse;margin-left:auto">
          <tr>
            <td style="font-size:12px;color:#666;padding:3px 0;padding-right:12px">Invoice No.</td>
            <td style="font-size:12px;color:#333;padding:2px 0">:</td>
            <td style="font-size:12px;font-weight:700;color:${NAVY};padding:3px 0;padding-left:8px">${inv.invoice_number}</td>
          </tr>
          <tr>
            <td style="font-size:12px;color:#666;padding:3px 0;padding-right:12px">Date</td>
            <td style="font-size:12px;color:#333;padding:2px 0">:</td>
            <td style="font-size:12px;font-weight:600;padding:3px 0;padding-left:8px">${dd(inv.issue_date)}</td>
          </tr>
          ${inv.billing_period_start ? `
          <tr>
            <td style="font-size:11px;color:#666;padding:3px 0;padding-right:12px">Period</td>
            <td style="font-size:11px;color:#333;padding:2px 0">:</td>
            <td style="font-size:11px;padding:3px 0;padding-left:8px">${formatBillingPeriod(inv.billing_period_start)}</td>
          </tr>` : ''}
          ${inv.due_date ? `
          <tr>
            <td style="font-size:11px;color:#666;padding:3px 0;padding-right:12px">Due Date</td>
            <td style="font-size:11px;color:#333;padding:2px 0">:</td>
            <td style="font-size:11px;font-weight:600;color:#c0392b;padding:3px 0;padding-left:8px">${dd(inv.due_date)}</td>
          </tr>` : ''}
        </table>
      </td>
    </tr>
  </table>

  <!-- ── ITEMS TABLE ── -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <thead>
      <tr style="background:${NAVY}">
        <th style="padding:9px 10px;text-align:center;color:white;font-size:11px;font-weight:700;letter-spacing:0.5px;width:36px">No.</th>
        <th style="padding:9px 10px;text-align:left;color:white;font-size:11px;font-weight:700;letter-spacing:0.5px;white-space:nowrap">Date</th>
        <th style="padding:9px 10px;text-align:left;color:white;font-size:11px;font-weight:700;letter-spacing:0.5px">Jobs Done</th>
        <th style="padding:9px 10px;text-align:center;color:white;font-size:11px;font-weight:700;letter-spacing:0.5px;width:40px">Qty</th>
        <th style="padding:9px 10px;text-align:right;color:white;font-size:11px;font-weight:700;letter-spacing:0.5px;white-space:nowrap">Rate</th>
        <th style="padding:9px 10px;text-align:right;color:white;font-size:11px;font-weight:700;letter-spacing:0.5px;white-space:nowrap">Total Amount</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows || `<tr><td colspan="6" style="padding:20px;text-align:center;color:#999;font-size:12px">No items</td></tr>`}
    </tbody>
  </table>

  <!-- ── TOTALS + PAYMENT INFO ── -->
  <table style="width:100%;border-collapse:collapse;margin-top:8px">
    <tr>
      <td style="vertical-align:top;width:52%;padding-right:20px">
        ${paymentBlock}
        ${inv.notes ? `<div style="margin-top:12px;font-size:11px;color:#666;font-style:italic">${inv.notes}</div>` : ''}
      </td>
      <td style="vertical-align:top;width:48%">
        <!-- Totals box -->
        <table style="width:100%;border-collapse:collapse">
          <tr style="border-bottom:1px solid #e8edf5">
            <td style="padding:7px 12px;font-size:12px;color:#555">Total Amount</td>
            <td style="padding:7px 12px;text-align:right;font-size:12px;font-weight:600">${inr(subtotal)}</td>
          </tr>
          ${prevBal > 0 ? `
          <tr style="border-bottom:1px solid #e8edf5">
            <td style="padding:7px 12px;font-size:12px;color:#c0392b">Previous Balance</td>
            <td style="padding:7px 12px;text-align:right;font-size:12px;color:#c0392b;font-weight:600">+ ${inr(prevBal)}</td>
          </tr>` : ''}
          <tr style="border-bottom:1px solid #e8edf5">
            <td style="padding:7px 12px;font-size:12px;color:#555">Total Amount Due</td>
            <td style="padding:7px 12px;text-align:right;font-size:12px;font-weight:600">${inr(totalDue)}</td>
          </tr>
          ${taxAmt > 0 ? `
          <tr style="border-bottom:1px solid #e8edf5">
            <td style="padding:7px 12px;font-size:12px;color:#555">Tax (${inv.tax_rate || 0}%)</td>
            <td style="padding:7px 12px;text-align:right;font-size:12px">${inr(taxAmt)}</td>
          </tr>` : ''}
          <tr style="border-bottom:1px solid #e8edf5">
            <td style="padding:7px 12px;font-size:12px;color:#555">Discount (if applicable)</td>
            <td style="padding:7px 12px;text-align:right;font-size:12px;color:#27ae60">${discount > 0 ? '- ' + inr(discount) : '—'}</td>
          </tr>
          <tr style="background:${NAVY}">
            <td style="padding:10px 12px;font-size:13px;font-weight:700;color:white">Total Payable</td>
            <td style="padding:10px 12px;text-align:right;font-size:14px;font-weight:900;color:white">: &nbsp;${inr(totalPayable)}</td>
          </tr>
        </table>

        ${(inv.paid_amount || 0) > 0 ? `
        <div style="margin-top:8px;padding:8px 12px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px">
          <div style="display:flex;justify-content:space-between;font-size:11px">
            <span style="color:#16a34a;font-weight:600">Amount Received</span>
            <span style="color:#16a34a;font-weight:700">${inr(inv.paid_amount || 0)}</span>
          </div>
          ${balanceDue(inv) > 0 ? `
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px;font-weight:700">
            <span style="color:#dc2626">Balance Due</span>
            <span style="color:#dc2626">${inr(balanceDue(inv))}</span>
          </div>` : ''}
        </div>` : ''}
      </td>
    </tr>
  </table>

  <!-- ── FOOTER ── -->
  <div style="margin-top:28px;border-top:2px solid ${NAVY};padding-top:14px;display:flex;justify-content:space-between;align-items:center">
    <div style="font-size:10px;color:#888">
      This is a computer-generated invoice. No signature required.
    </div>
    <div style="text-align:center">
      <div style="font-size:20px;font-weight:900;color:${NAVY}">${co.footerText}</div>
      <div style="margin-top:6px;display:flex;align-items:center;justify-content:center;gap:6px">
        ${footerLogoBlock}
        <span style="font-size:13px;font-weight:900;color:${NAVY}">${co.name}</span>
        ${showTagline ? `<span style="font-size:9px;color:#888;font-weight:600;letter-spacing:1px;text-transform:uppercase">${co.tagline}</span>` : ''}
      </div>
    </div>
  </div>

</body>
</html>`

    return html
  }

  function printInvoice(inv: Invoice) {
    const html = buildInvoiceHtml(inv)
    const w = window.open('', '_blank', 'width=800,height=900')
    if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 400) }
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
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search invoice or client…"
              className="w-full bg-background/60 border border-border/40 rounded-lg pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-violet-500/50"
            />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {['', 'draft', 'reviewed', 'sent', 'partial', 'overdue'].map(s => (
              <button key={s}
                onClick={() => setFilterStatus(s)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${filterStatus === s ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}
              >{s ? getStatusLabel(s) : 'All'}</button>
            ))}
          </div>
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
                className={`px-3 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors ${isSelected ? 'bg-violet-500/10 border-l-2 border-l-violet-500' : 'border-l-2 border-l-transparent'}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); copyInvNum(inv.invoice_number) }}
                        title="Copy invoice number"
                        className="flex items-center gap-0.5 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors group/copy"
                      >
                        {inv.invoice_number}
                        <Copy className="w-2.5 h-2.5 ml-0.5 opacity-0 group-hover/copy:opacity-50 transition-opacity" />
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
                    {inv.paid_amount > 0 && inv.status !== 'paid' && (
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
                <Copy className={`w-3 h-3 shrink-0 transition-colors ${copiedInvNum ? 'text-green-400' : 'opacity-0 group-hover:opacity-60'}`} />
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
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-white/5 rounded-lg transition-colors">
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setPreviewInv(inv)} title="Preview invoice"
              className="p-1.5 text-muted-foreground hover:text-violet-400 hover:bg-violet-500/10 rounded-lg transition-colors">
              <Eye className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => printInvoice(inv)} title="Print"
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-white/5 rounded-lg transition-colors">
              <Printer className="w-3.5 h-3.5" />
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
          <div className="bg-white/[0.03] rounded-xl border border-border/40 p-3">
            <div className="flex items-center gap-1 mb-3">
              {STATUS_PIPELINE.map((s, idx) => {
                const pos = STATUS_PIPELINE.indexOf(inv.status)
                const isPast = idx < pos
                const isCurrent = s === inv.status
                return (
                  <div key={s} className="flex items-center flex-1 min-w-0">
                    <div className={`text-center flex-1 min-w-0 ${isCurrent ? 'text-violet-400' : isPast ? 'text-green-400' : 'text-muted-foreground/40'}`}>
                      <div className={`mx-auto w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold mb-0.5
                        ${isCurrent ? 'bg-violet-500/20 border border-violet-500' : isPast ? 'bg-green-500/20 border border-green-500' : 'bg-white/5 border border-border/40'}`}>
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
                  onClick={() => setPanelMode('pay')}
                  className="flex-1 min-w-[120px] py-1.5 px-3 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors">
                  <CreditCard className="w-3.5 h-3.5" />Record Payment
                </button>
              )}
              {inv.status === 'draft' && (
                <button
                  onClick={() => setPanelMode('pay')}
                  className="flex-1 min-w-[120px] py-1.5 px-3 bg-white/[0.06] hover:bg-white/[0.1] text-foreground text-xs font-medium rounded-lg flex items-center justify-center gap-1.5 transition-colors border border-border/40">
                  <CreditCard className="w-3.5 h-3.5" />Quick Pay
                </button>
              )}
            </div>

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
          <div className="bg-white/[0.03] rounded-xl border border-border/40 p-3 space-y-2">
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
                    <span className="text-muted-foreground text-xs">−₹</span>
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
                  <span className="text-muted-foreground text-xs text-red-400/70">+₹</span>
                  <input
                    type="number" min="0"
                    key={`prevbal-${inv.id}-${inv.previous_balance}`}
                    defaultValue={inv.previous_balance || 0}
                    onBlur={e => updatePreviousBalance(inv.id, parseFloat(e.target.value) || 0)}
                    className="w-20 bg-background border border-border/40 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:border-red-500/50 text-red-400"
                  />
                </div>
              ) : (
                <span className={inv.previous_balance > 0 ? 'text-red-400' : 'text-muted-foreground'}>
                  {inv.previous_balance > 0 ? `+${fmt(inv.previous_balance, inv.currency)}` : '—'}
                </span>
              )}
            </div>

            <div className="border-t border-border/40 pt-2 flex justify-between">
              <span className="font-semibold">Total</span>
              <span className="font-bold text-base">{fmt(inv.total_amount, inv.currency)}</span>
            </div>
            {inv.paid_amount > 0 && (
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

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Line Items ({inv.items?.length || 0})
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
                <div className="text-xs text-muted-foreground text-center py-4 bg-white/[0.02] rounded-lg border border-dashed border-border/40">
                  No items yet — tasks marked "done" auto-appear here
                </div>
              )}
              {(inv.items || []).sort((a, b) => a.display_order - b.display_order).map(item => (
                <div key={item.id} className="flex items-start gap-2 p-2 bg-white/[0.02] rounded-lg border border-border/30 hover:border-border/60 transition-colors group">
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
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-red-400 transition-all">
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
                      type="number" min="0" placeholder="₹"
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
          {(editable || inv.discount_amount > 0) && (
            <div className="bg-white/[0.03] rounded-xl border border-border/40 overflow-hidden">
              <button
                onClick={() => {
                  if (!showDiscount) { setShowDiscount(true); loadDiscountCalc(inv.client_id, inv.id) }
                  else setShowDiscount(false)
                }}
                className="w-full px-3 py-2.5 flex items-center justify-between text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors">
                <span className="flex items-center gap-1.5">
                  <Percent className="w-3.5 h-3.5 text-orange-400" />
                  Discount Calculator
                  {inv.discount_amount > 0 && (
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
                        <div className="bg-white/[0.03] rounded-lg p-2 text-center">
                          <div className="text-[10px] text-muted-foreground">Total Billed</div>
                          <div className="text-xs font-semibold">{fmt(discountCalc.totalBilled)}</div>
                        </div>
                        <div className="bg-white/[0.03] rounded-lg p-2 text-center">
                          <div className="text-[10px] text-muted-foreground">Payment Rate</div>
                          <div className={`text-xs font-semibold ${discountCalc.paymentRate >= 0.95 ? 'text-green-400' : discountCalc.paymentRate >= 0.8 ? 'text-amber-400' : 'text-red-400'}`}>
                            {(discountCalc.paymentRate * 100).toFixed(0)}%
                          </div>
                        </div>
                        <div className="bg-white/[0.03] rounded-lg p-2 text-center">
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
                              <label className="text-[10px] text-muted-foreground mb-1 block">Discount Amount (₹)</label>
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
                              <div key={i} className="flex items-center justify-between text-[10px] p-1.5 bg-white/[0.02] rounded border border-border/20">
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
          <div className="bg-white/[0.03] rounded-xl border border-border/40 overflow-hidden">
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
                      <div key={log.id} className="p-2 bg-white/[0.02] rounded-lg border border-border/20 text-[10px]">
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
                      <div className="font-medium text-green-400">{fmt(p.amount, inv.currency)}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {fmtDate(p.payment_date)} · {METHOD_LABEL[p.payment_method] || p.payment_method}
                        {p.reference && ` · ${p.reference}`}
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
            <div className="text-xs text-muted-foreground bg-white/[0.02] rounded-lg p-3 border border-border/30">
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
          <button onClick={() => setPanelMode('detail')} className="p-1.5 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* Quick amount buttons */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Amount</label>
            <div className="flex gap-2 mb-2 flex-wrap">
              {balance > 0 && [balance, balance / 2].filter(v => v > 0).map((v, i) => (
                <button key={i}
                  onClick={() => setPayForm(p => ({ ...p, amount: v.toFixed(2) }))}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${parseFloat(payForm.amount) === v ? 'bg-violet-500/20 border-violet-500/50 text-violet-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}>
                  {i === 0 ? 'Full' : 'Half'} {fmt(v, inv.currency)}
                </button>
              ))}
            </div>
            <input
              type="number" value={payForm.amount}
              onChange={e => setPayForm(p => ({ ...p, amount: e.target.value }))}
              placeholder="0.00" min="0"
              className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-violet-500/50"
            />
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
            const entered = parseFloat(payForm.amount) || 0
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
          <div className={`flex items-start gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${isAdvancePayment ? 'bg-amber-500/10 border-amber-500/30' : 'bg-white/[0.02] border-border/40 hover:border-border/60'}`}
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
          <button onClick={() => setPanelMode('detail')} className="p-1.5 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-foreground">
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
          <div className="grid grid-cols-2 gap-3">
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
                    placeholder="₹"
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
    const selectedTotal = genTasks.filter(t => genSelectedIds.has(t.id)).reduce((s, t) => s + (t.billing_amount_inr || 0), 0)
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-1.5">
              <Zap className="w-4 h-4 text-amber-400" />Generate Invoice
            </h3>
            <p className="text-[11px] text-muted-foreground">Pick a client + period → fetch done tasks → create invoice</p>
          </div>
          <button onClick={() => { setPanelMode('detail'); setGenTasks([]) }} className="p-1.5 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-foreground">
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
            <div className="grid grid-cols-2 gap-3">
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
            className="w-full py-2 bg-white/[0.06] hover:bg-white/[0.1] border border-border/40 text-sm font-medium rounded-xl flex items-center justify-center gap-2 transition-colors disabled:opacity-50">
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
                    ${hasConflict ? 'bg-amber-500/5 border-amber-500/30' : genSelectedIds.has(task.id) ? 'bg-violet-500/10 border-violet-500/30' : 'bg-white/[0.02] border-border/30 hover:border-border/60'}`}>
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
                    <span className="text-xs font-semibold shrink-0">{fmt(task.billing_amount_inr || 0, task.currency || 'INR')}</span>
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
            <div className="text-xs text-muted-foreground text-center py-6 bg-white/[0.02] rounded-xl border border-dashed border-border/40">
              Click "Fetch Done Tasks" to see available tasks
            </div>
          )}
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RIGHT PANEL — Statement Generator
  // ─────────────────────────────────────────────────────────────────────────
  function renderStatementPanel() {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-1.5">
              <Receipt className="w-4 h-4 text-blue-400" />Statement Generator
            </h3>
            <p className="text-[11px] text-muted-foreground">Print account statements by month, year, range, or specific day</p>
          </div>
          <button onClick={() => setPanelMode('detail')} className="p-1.5 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">

          {/* Client */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Client (leave blank for all)</label>
            <Combobox
              options={[{ id: '', label: 'All Clients', sub: 'combined statement' }, ...clients.map(c => ({ id: c.id, label: c.name, sub: c.code }))]}
              value={stmtForm.client_id}
              onChange={v => setStmtForm(p => ({ ...p, client_id: v }))}
              placeholder="All clients…"
              sortKey="clients"
            />
          </div>

          {/* Mode */}
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block">Period Type</label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                ['month', '📅 Month'],
                ['year',  '📆 Year'],
                ['range', '🗓️ Date Range'],
                ['day',   '📌 Specific Day'],
              ] as const).map(([m, label]) => (
                <button key={m} onClick={() => setStmtForm(p => ({ ...p, mode: m }))}
                  className={`py-1.5 text-xs rounded-lg border transition-colors ${stmtForm.mode === m ? 'bg-blue-500/20 border-blue-500/50 text-blue-300' : 'border-border/40 text-muted-foreground hover:border-border'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Date inputs */}
          {stmtForm.mode === 'month' && (
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Month</label>
              <input type="month" value={stmtForm.month}
                onChange={e => setStmtForm(p => ({ ...p, month: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50"
              />
            </div>
          )}
          {stmtForm.mode === 'year' && (
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Year</label>
              <input type="number" min="2020" max="2030" value={stmtForm.year}
                onChange={e => setStmtForm(p => ({ ...p, year: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50"
              />
            </div>
          )}
          {stmtForm.mode === 'range' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">From</label>
                <input type="date" value={stmtForm.date_from}
                  onChange={e => setStmtForm(p => ({ ...p, date_from: e.target.value }))}
                  className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block">To</label>
                <input type="date" value={stmtForm.date_to}
                  onChange={e => setStmtForm(p => ({ ...p, date_to: e.target.value }))}
                  className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50"
                />
              </div>
            </div>
          )}
          {stmtForm.mode === 'day' && (
            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block">Date</label>
              <input type="date" value={stmtForm.specific_date}
                onChange={e => setStmtForm(p => ({ ...p, specific_date: e.target.value }))}
                className="w-full bg-background border border-border/40 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500/50"
              />
            </div>
          )}

          {/* Preview counts */}
          {(() => {
            let from = '', to = ''
            if (stmtForm.mode === 'month') {
              from = stmtForm.month + '-01'
              const d = new Date(stmtForm.month + '-01')
              const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
              to = `${stmtForm.month}-${lastDay}`
            } else if (stmtForm.mode === 'year') {
              from = `${stmtForm.year}-01-01`; to = `${stmtForm.year}-12-31`
            } else if (stmtForm.mode === 'day') {
              from = to = stmtForm.specific_date
            } else {
              from = stmtForm.date_from; to = stmtForm.date_to
            }
            const preview = invoices.filter(inv => {
              if (stmtForm.client_id && inv.client_id !== stmtForm.client_id) return false
              const d = inv.issue_date || ''
              return d >= from && d <= to
            })
            const totalBilled  = preview.reduce((s, i) => s + (i.total_amount || 0), 0)
            const totalPaid    = preview.reduce((s, i) => s + (i.paid_amount  || 0), 0)
            return preview.length > 0 ? (
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-3 space-y-1.5">
                <div className="text-[10px] text-blue-400/80 font-semibold uppercase tracking-wider">Preview</div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{preview.length} invoice{preview.length !== 1 ? 's' : ''}</span>
                  <span className="font-medium">{fmt(totalBilled)}</span>
                </div>
                <div className="flex justify-between text-xs text-green-400">
                  <span>Paid</span><span>{fmt(totalPaid)}</span>
                </div>
                <div className="flex justify-between text-xs font-semibold text-red-400">
                  <span>Outstanding</span><span>{fmt(totalBilled - totalPaid)}</span>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground text-center py-3 bg-white/[0.02] rounded-xl border border-dashed border-border/40">
                No invoices in selected period
              </div>
            )
          })()}

          <button onClick={printStatement}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors">
            <Printer className="w-4 h-4" />Print Statement
          </button>
          <button onClick={printDetailedStatement}
            className="w-full py-2.5 px-4 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-300 text-sm font-medium transition-colors flex items-center justify-center gap-2">
            <FileText className="w-4 h-4" />Print Detailed Statement
            <span className="text-[10px] opacity-60">(tasks · payments · discounts)</span>
          </button>
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
    const totalBadDebt    = badDebtInvoices.reduce((s, i) => s + (i.total_amount || 0), 0)
    const badDebtUnpaid   = badDebtInvoices.reduce((s, i) => s + Math.max(0, (i.total_amount || 0) - (i.paid_amount || 0)), 0)
    const bdByClient      = Object.values(
      badDebtInvoices.reduce((map: any, inv) => {
        const id = inv.client_id
        if (!map[id]) map[id] = { name: inv.client?.name || '—', total: 0, unpaid: 0, count: 0, invoices: [] }
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
    const totalOverdue  = overdueFiltered.reduce((s, i) => s + Math.max(0, (i.total_amount || 0) - (i.paid_amount || 0)), 0)
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
          <button onClick={() => setPanelMode('detail')} className="p-1.5 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-foreground">
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
              }}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium rounded-t-lg border border-b-0 transition-colors ${analyticsTab === t.id ? t.active : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
              {t.label}
              {t.count > 0 && (
                <span className={`text-[9px] px-1 py-0.5 rounded-full ${analyticsTab === t.id ? 'bg-white/20' : 'bg-white/[0.06]'}`}>{t.count}</span>
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
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Entries</div>
                  <div className="text-sm font-bold">{discRows.length}</div>
                </div>
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Avg %</div>
                  <div className="text-sm font-bold">{avgDiscPct.toFixed(1)}%</div>
                </div>
              </div>

              {/* Filter */}
              <FilterDropdown
                options={discClients.map((c: any) => {
                  const cnt = discAnalytics.filter((d: any) => d.client?.id === c.id).length
                  const tot = discAnalytics.filter((d: any) => d.client?.id === c.id).reduce((s: number, d: any) => s + (d.discount_amount || 0), 0)
                  return { value: c.id, label: `${c.name} — ${cnt} · ${fmt(tot)}` }
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
                        className="p-2.5 bg-white/[0.02] rounded-lg border border-border/30 hover:border-orange-500/30 cursor-pointer transition-colors">
                        <div className="flex items-center justify-between mb-1.5">
                          <div>
                            <div className="text-xs font-medium">{c.name}</div>
                            <div className="text-[10px] text-muted-foreground">{cRows.length} discount{cRows.length !== 1 ? 's' : ''} · avg {cAvg.toFixed(1)}%</div>
                          </div>
                          <div className="text-sm font-semibold text-orange-400">{fmt(cTotal)}</div>
                        </div>
                        <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
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
                    {discFilterClient ? `${discRows.length} entries · ${fmt(totalDiscGiven)} total` : 'All Entries'}
                  </div>
                  {discFilterClient && (
                    <button onClick={() => setDiscFilterClient('')} className="text-[10px] text-orange-400 hover:text-orange-300">Clear ×</button>
                  )}
                </div>
                {discAnalyticsLoading ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">Loading…</div>
                ) : discRows.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground bg-white/[0.02] rounded-xl border border-dashed border-border/40">No discounts recorded yet</div>
                ) : (
                  <div className="space-y-2">
                    {discRows.map((d: any, i: number) => (
                      <div key={d.id || i} className="p-3 bg-white/[0.02] rounded-xl border border-border/30 hover:border-orange-500/20 transition-colors">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="min-w-0">
                            <div className="text-xs font-medium">{d.client?.name || '—'}</div>
                            <div className="text-[10px] text-muted-foreground font-mono">{d.invoice?.invoice_number || '—'}</div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-sm font-bold text-orange-400">{fmt(d.discount_amount || 0)}</div>
                            {(d.discount_percentage || 0) > 0 && (
                              <div className="text-[10px] text-muted-foreground">{(d.discount_percentage || 0).toFixed(1)}% off</div>
                            )}
                          </div>
                        </div>
                        {d.reason && d.reason !== 'No reason provided' && (
                          <div className="text-[10px] text-muted-foreground italic bg-white/[0.02] px-2 py-1 rounded">{d.reason}</div>
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
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Invoices</div>
                  <div className="text-sm font-bold">{badDebtInvoices.length}</div>
                </div>
              </div>

              {badDebtInvoices.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground bg-white/[0.02] rounded-xl border border-dashed border-border/40">
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
                                <div className="text-sm font-bold text-red-400">{fmt(c.unpaid)}</div>
                                {c.total !== c.unpaid && (
                                  <div className="text-[10px] text-muted-foreground">of {fmt(c.total)} billed</div>
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
                    <div className="bg-white/[0.03] rounded-xl border border-border/40 p-3">
                      <div className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Recovery Rate</div>
                      <div className="flex items-center justify-between text-sm mb-1.5">
                        <span className="text-green-400">Recovered</span>
                        <span className="font-semibold text-green-400">{fmt(totalBadDebt - badDebtUnpaid)}</span>
                      </div>
                      <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
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
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground bg-white/[0.04] hover:bg-white/[0.08] border border-border/40 rounded-lg transition-colors disabled:opacity-50">
                  <RefreshCw size={10} className={jobLossesLoading ? 'animate-spin' : ''} />
                  {jobLossesLoading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-rose-400/70 mb-0.5">Total Loss</div>
                  <div className="text-sm font-bold text-rose-300">{fmt(totalLoss)}</div>
                </div>
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Jobs</div>
                  <div className="text-sm font-bold">{lossFiltered.length}</div>
                </div>
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
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
                      <div key={type} className="bg-white/[0.02] border border-border/30 rounded-lg p-2 text-center">
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
                <div className="py-10 text-center text-xs text-muted-foreground bg-white/[0.02] rounded-xl border border-dashed border-border/40">
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
                          <div className="mt-2 h-1 bg-white/[0.06] rounded-full overflow-hidden">
                            <div className="h-full bg-rose-500/50 rounded-full" style={{ width: `${job.completion_pct}%` }} />
                          </div>
                        )}
                        {job.cancellation_notes && (
                          <div className="text-[10px] text-muted-foreground italic mt-1.5 bg-white/[0.02] px-2 py-1 rounded">
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
                                  <div key={ci} className="flex items-center justify-between text-[10px] px-2 py-1 bg-white/[0.03] rounded">
                                    <span className="text-foreground font-medium">
                                      {c.employee?.name || '—'}
                                      {c.employee?.cqid && <span className="text-muted-foreground ml-1">#{c.employee.cqid}</span>}
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
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Invoices</div>
                  <div className="text-sm font-bold">{overdueFiltered.length}</div>
                </div>
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
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
                <div className="py-10 text-center text-xs text-muted-foreground bg-white/[0.02] rounded-xl border border-dashed border-border/40">
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
                          <div key={i} className="p-2.5 bg-white/[0.02] rounded-lg border border-border/30">
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
                                    className="flex items-center justify-between text-[10px] px-2 py-1 bg-white/[0.02] rounded cursor-pointer hover:bg-amber-500/10 transition-colors">
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
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Payments</div>
                  <div className="text-sm font-bold">{advFiltered.length}</div>
                </div>
                <div className="bg-white/[0.03] border border-border/40 rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Clients</div>
                  <div className="text-sm font-bold">{new Set(advFiltered.map((p: any) => p.invoice?.client_id)).size}</div>
                </div>
              </div>

              {advanceLoading ? (
                <div className="py-8 text-center text-xs text-muted-foreground">Loading advance payments…</div>
              ) : advFiltered.length === 0 ? (
                <div className="py-10 text-center text-xs text-muted-foreground bg-white/[0.02] rounded-xl border border-dashed border-border/40">
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

        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN RENDER
  // ─────────────────────────────────────────────────────────────────────────
  const showRightPanel = selectedInv || ['new', 'generate', 'statement', 'discounts'].includes(panelMode)

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <Header title="Invoices" />
      <ToastContainer toasts={toasts} onDismiss={dismiss} />

      {/* ── Confirmation modal ── */}
      {confirmModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setConfirmModal(null) }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative bg-[#0d1117] border border-white/10 rounded-2xl shadow-2xl w-full max-w-sm p-5 animate-in fade-in zoom-in-95 duration-150">
            <h3 className="font-semibold text-sm mb-2">{confirmModal.title}</h3>
            <p className="text-sm text-muted-foreground mb-5 leading-relaxed">{confirmModal.body}</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmModal(null)}
                className="flex-1 py-2.5 rounded-xl border border-white/10 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-white/20 transition-colors">
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

      {/* ── Stats bar ── */}
      <div className="border-b border-border/40 px-4 py-2.5 grid grid-cols-2 sm:grid-cols-6 gap-3">
        <div className="bg-white/[0.03] rounded-xl p-3 border border-border/30">
          <div className="text-[10px] text-muted-foreground mb-0.5">Outstanding</div>
          <div className="text-sm font-bold text-foreground">{fmt(stats.outstanding)}</div>
        </div>
        <div className={`bg-white/[0.03] rounded-xl p-3 border ${stats.overdueCount > 0 ? 'border-red-500/30' : 'border-border/30'}`}>
          <div className="text-[10px] text-muted-foreground mb-0.5">Overdue</div>
          <div className={`text-sm font-bold ${stats.overdueCount > 0 ? 'text-red-400' : 'text-foreground'}`}>
            {fmt(stats.overdueAmt)}
            {stats.overdueCount > 0 && <span className="ml-1 text-[10px]">({stats.overdueCount})</span>}
          </div>
        </div>
        <div className={`bg-white/[0.03] rounded-xl p-3 border ${stats.draftCount > 0 ? 'border-amber-500/30' : 'border-border/30'}`}>
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
            {panelMode === 'new'       && renderNewPanel()}
            {panelMode === 'generate'  && renderGeneratePanel()}
            {panelMode === 'statement' && renderStatementPanel()}
            {panelMode === 'discounts' && renderDiscountsPanel()}
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
          <div className="flex flex-col bg-[#0d1117] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
            style={{ width: 'min(860px, 96vw)', height: 'min(92vh, 900px)' }}>
            {/* Modal header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
              <div className="flex items-center gap-2.5">
                <Eye className="w-4 h-4 text-violet-400" />
                <div>
                  <h3 className="font-semibold text-sm">{previewInv.invoice_number}</h3>
                  <p className="text-[11px] text-muted-foreground">{previewInv.client?.name}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => printInvoice(previewInv)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-xs font-medium text-foreground transition-colors border border-white/10">
                  <Printer className="w-3.5 h-3.5" />Print / Download
                </button>
                <button onClick={() => setPreviewInv(null)}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-white/5 rounded-lg transition-colors">
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
          <div className="bg-[#111827] border border-border/60 rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4">
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
                className="flex-1 py-2 border border-border/40 text-sm text-muted-foreground rounded-xl hover:bg-white/5 transition-colors">
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
    </div>
  )
}
