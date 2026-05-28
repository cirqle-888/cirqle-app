'use client'

import { useState, useMemo } from 'react'
import dynamic from 'next/dynamic'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { insertCashbookEntries, updateCashbookEntry, softDeleteCashbookEntry } from './actions'
import { formatCompact } from '@/lib/calculations/currency'
import { Plus, X, TrendingUp, TrendingDown, Minus, Upload, ShieldAlert, Trash2, Edit2, Link as LinkIcon, Save } from 'lucide-react'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import type { Currency } from '@/types'
import { ModalOverlay } from '@/components/ui/modal-overlay'

import Link from 'next/link'

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

interface Entry {
  id: string
  type: 'inflow' | 'outflow'
  category_id: string
  bank_account_id?: string
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
  deleted_at?: string | null
  category?: { id: string; name: string; type: string }
  bank_account?: { id: string; name: string }
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
      client?: { name: string }
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
}

interface DueInvoice {
  id: string
  invoice_number: string
  status: string
  due_date: string
  total_amount: number
  paid_amount: number
  currency: string
  client?: { name: string; code: string }
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
   * True when the viewer holds `cashbook.view_amounts`. When false, amount
   * and amount_inr are already absent from `initialEntries` (stripped
   * server-side); the client uses this flag to suppress the totals row,
   * inflow/outflow KPI cards, and the entry-row amount column.
   */
  showAmounts: boolean
}

const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

export default function CashBookClient({ initialEntries, categories, bankAccounts, exchangeRates, dueInvoices, employees, clients, outstandingCredits, showAmounts }: Props) {
  const [entries, setEntries] = useState<Entry[]>(initialEntries)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterMonth, setFilterMonth] = useState('')
  const [filterSearch, setFilterSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [filterAllocStatus, setFilterAllocStatus] = useState('')
  const [recurringMonths, setRecurringMonths] = useState(0) // 0 = not recurring

  // Inline edit state
  const [editingRow, setEditingRow] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<Partial<Entry>>({})
  
  // Allocations modal state
  const [allocatingEntry, setAllocatingEntry] = useState<Entry | null>(null)
  const [allocatingPayrollEntry, setAllocatingPayrollEntry] = useState<Entry | null>(null)

  const invoiceCategoryId = useMemo(() => categories.find(c => c.name.toLowerCase().includes('invoice'))?.id, [categories])
  const salaryCategoryId = useMemo(() => categories.find(c => c.name.toLowerCase().includes('salary'))?.id, [categories])

  const [form, setForm] = useState({
    type: 'inflow' as 'inflow' | 'outflow',
    category_id: invoiceCategoryId,
    bank_account_id: '',
    amount: '',
    currency: 'INR' as Currency,
    entry_date: new Date().toISOString().split('T')[0],
    description: '',
    reference: '',
    linked_invoice_id: '',
    fully_paid: false,
  })

  const supabase = createClient()

  const rateMap = useMemo(() => {
    const m: Record<string, number> = {}
    exchangeRates.forEach(r => { m[r.currency] = r.rate_to_inr })
    return m
  }, [exchangeRates])

  function getInrAmount(amount: number, currency: Currency) {
    if (currency === 'INR') return amount
    return amount * (rateMap[currency] || 1)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const amount = parseFloat(form.amount) || 0
    const amountInr = getInrAmount(amount, form.currency)

    // Build list of dates (base date + recurring copies)
    const baseDates: string[] = [form.entry_date]
    if (recurringMonths > 0) {
      const base = new Date(form.entry_date)
      for (let m = 1; m <= recurringMonths; m++) {
        const d = new Date(base)
        d.setMonth(d.getMonth() + m)
        baseDates.push(d.toISOString().split('T')[0])
      }
    }

    // Insert all entries
    const payload = baseDates.map((entry_date, i) => ({
      type: form.type,
      category_id: form.category_id,
      bank_account_id: form.bank_account_id || null,
      amount,
      currency: form.currency,
      amount_inr: amountInr,
      entry_date,
      description: recurringMonths > 0 && i > 0
        ? `${form.description}${form.description ? ' ' : ''}(recurring ${i + 1}/${baseDates.length})`
        : form.description,
      reference: form.reference,
      invoice_id: form.linked_invoice_id || null, // Storing strict database link
    }))

    const result = await insertCashbookEntries(
      baseDates,
      {
        type: form.type,
        category_id: form.category_id,
        bank_account_id: form.bank_account_id || null,
        amount,
        currency: form.currency,
        amount_inr: amountInr,
        description: form.description,
        reference: form.reference,
        invoice_id: form.linked_invoice_id || null,
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
      const allInserted = result.data.entries
      // Add all inserted entries to local state (sorted newest first)
      setEntries(prev => [...[...allInserted].reverse(), ...prev])
      setShowForm(false)
      setRecurringMonths(0)
      setForm({ type: 'inflow', category_id: invoiceCategoryId, bank_account_id: '', amount: '', currency: 'INR', entry_date: new Date().toISOString().split('T')[0], description: '', reference: '', linked_invoice_id: '', fully_paid: false })
    }
    setSaving(false)
  }

  async function handleInlineSave() {
    if (!editingRow) return
    setSaving(true)
    const amount_inr = getInrAmount(Number(editForm.amount) || 0, (editForm.currency ?? 'INR') as Currency)
    const result = await updateCashbookEntry(editingRow, {
      entry_date: editForm.entry_date ?? new Date().toISOString().split('T')[0],
      amount: editForm.amount ?? 0,
      amount_inr,
      currency: editForm.currency ?? 'INR',
      category_id: editForm.category_id,
      bank_account_id: editForm.bank_account_id || null,
      description: editForm.description ?? '',
      reference: editForm.reference ?? '',
    })
    if (result.ok) {
      setEntries(prev => prev.map(e => e.id === editingRow ? { ...e, ...editForm, amount_inr } : e))
      setEditingRow(null)
    }
    setSaving(false)
  }

  async function handleSoftDelete(entryId: string) {
    if (!confirm('Delete this entry? It can be restored from the Reconciliation Toolkit.')) return
    const result = await softDeleteCashbookEntry(entryId)
    if (result.ok) {
      // Remove from local list immediately (soft-deleted entries are hidden)
      setEntries(prev => prev.filter(e => e.id !== entryId))
    }
  }

  const today = new Date().toISOString().split('T')[0]
  const sortedDueInvoices = [...dueInvoices].sort((a, b) => {
    const aOverdue = a.due_date && a.due_date < today
    const bOverdue = b.due_date && b.due_date < today
    if (aOverdue && !bOverdue) return -1
    if (!aOverdue && bOverdue) return 1
    return (a.due_date || '').localeCompare(b.due_date || '')
  })

  const isInvoiceCategory = form.category_id === invoiceCategoryId && form.type === 'inflow'

  // Determine smart mode from selected category name
  const selectedCat = categories.find(c => c.id === form.category_id)
  const smartMode = selectedCat ? (SMART[selectedCat.name.toLowerCase()] || null) : null

  // Extra smart state (credit given/return, salary, client link)
  const [smartExtra, setSmartExtra] = useState<Record<string, string>>({})

  function resetSmart() { setSmartExtra({}) }

  const filteredEntries = useMemo(() => {
    let result = entries
    if (filterType) result = result.filter(e => e.type === filterType)
    if (filterMonth) result = result.filter(e => e.entry_date?.startsWith(filterMonth))
    if (filterCategory) result = result.filter(e => e.category_id === filterCategory)
    
    if (filterSearch) {
      const q = filterSearch.toLowerCase()
      result = result.filter(e => 
        e.description?.toLowerCase().includes(q) ||
        e.reference?.toLowerCase().includes(q) ||
        e.category?.name.toLowerCase().includes(q) ||
        e.bank_account?.name.toLowerCase().includes(q) ||
        e.allocations?.some(a => 
          a.invoice?.invoice_number.toLowerCase().includes(q) || 
          a.invoice?.client?.name.toLowerCase().includes(q)
        )
      )
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

    return result
  }, [entries, filterType, filterMonth, filterSearch, filterCategory, filterAllocStatus, invoiceCategoryId, salaryCategoryId])

  const totalInflow = filteredEntries.filter(e => e.type === 'inflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const totalOutflow = filteredEntries.filter(e => e.type === 'outflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const net = totalInflow - totalOutflow

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

  return (
    <div>
      <Header
        title="Cash Book"
        subtitle="Track all income and expenses"
        actions={
          <div className="flex items-center gap-2">
            <Link href="/dashboard/cashbook/reconciliation"
              className="flex items-center gap-1.5 bg-secondary text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors whitespace-nowrap">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Reconciliation</span>
            </Link>
            <Link href="/dashboard/import?tab=cashbook_entries"
              className="flex items-center gap-1.5 bg-secondary text-sm font-medium px-3 py-2 rounded-lg hover:bg-secondary/80 transition-colors whitespace-nowrap">
              <Upload className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">Import</span>
            </Link>
            <button onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-3 py-2 rounded-lg hover:opacity-90 transition-opacity whitespace-nowrap">
              <Plus className="w-4 h-4 shrink-0" />
              Add Entry
            </button>
          </div>
        }
      />

      <div className="p-6 space-y-5">
        {/* Summary — only rendered when the viewer can see ₹ amounts. Without
            cashbook.view_amounts the totals would collapse to ₹0 and mislead. */}
        {showAmounts && (
          <div className="grid grid-cols-3 gap-4">
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
          </div>
        )}

        {/* Filters */}
        <div className="flex gap-3 flex-wrap items-center bg-secondary/20 p-3 rounded-xl border border-border">
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
            {categoriesByRecentUse.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <select 
            value={filterAllocStatus} 
            onChange={e => setFilterAllocStatus(e.target.value)}
            className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">All Allocations</option>
            <option value="unallocated">Unallocated</option>
            <option value="partial">Partially Allocated</option>
            <option value="fully">Fully Allocated</option>
            <option value="over">Over-allocated</option>
          </select>

          <input
            type="text"
            placeholder="Search descriptions, clients..."
            value={filterSearch}
            onChange={e => setFilterSearch(e.target.value)}
            className="bg-background border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50 w-full sm:w-auto flex-1 min-w-[200px]"
          />

          {(filterMonth || filterCategory || filterSearch || filterAllocStatus) && (
            <button onClick={() => { setFilterMonth(''); setFilterCategory(''); setFilterSearch(''); setFilterAllocStatus('') }} className="text-xs text-muted-foreground hover:text-foreground px-2">Clear</button>
          )}
        </div>

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
                <div key={entry.id} className="p-4 flex flex-col gap-3 hover:bg-secondary/20 transition-colors group">
                  <div className="flex justify-between items-start gap-4">
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

                  <div className="text-sm text-muted-foreground">
                    {isEditing ? (
                      <input type="text" value={editForm.description || ''} onChange={e => setEditForm(p => ({...p, description: e.target.value}))} className="bg-background border rounded px-2 py-1 w-full text-xs" />
                    ) : (
                      entry.description || '—'
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        {isEditing ? (
                          <input type="date" value={editForm.entry_date || ''} onChange={e => setEditForm(p => ({...p, entry_date: e.target.value}))} className="bg-background border rounded px-2 py-1" />
                        ) : (
                          entry.entry_date
                        )}
                      </span>
                      <span>•</span>
                      <span>
                        {isEditing ? (
                          <select value={editForm.bank_account_id || ''} onChange={e => setEditForm(p => ({...p, bank_account_id: e.target.value}))} className="bg-background border rounded px-2 py-1">
                            <option value="">Cash</option>
                            {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                          </select>
                        ) : (
                          entry.bank_account?.name || 'Cash'
                        )}
                      </span>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      {isEditing ? (
                        <>
                          <button onClick={handleInlineSave} disabled={saving} className="p-1.5 rounded-md hover:bg-primary/20 text-primary transition-colors" title="Save changes"><Save className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setEditingRow(null)} disabled={saving} className="p-1.5 rounded-md hover:bg-secondary/80 text-muted-foreground transition-colors" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                        </>
                      ) : (
                        <>
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
                          <button onClick={() => { setEditingRow(entry.id); setEditForm(entry); }} className="p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors" title="Edit entry">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleSoftDelete(entry.id)}
                            className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            title="Delete entry (reversible)"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Allocation Badges */}
                  {allocStatus && allocStatus !== 'none' && (
                    <div className="mt-1">
                      {allocStatus === 'partial' && <span className="inline-block bg-blue-500/10 text-blue-400 text-[9px] px-1.5 py-0.5 rounded font-medium">Partially Allocated</span>}
                      {allocStatus === 'over' && <span className="inline-block bg-red-500/10 text-red-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Over-allocated!</span>}
                      {allocStatus === 'fully' && <span className="inline-block bg-green-500/10 text-green-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Fully Allocated</span>}
                    </div>
                  )}
                  {allocStatus === 'none' && <div className="mt-1"><span className="inline-block bg-amber-500/10 text-amber-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Unallocated</span></div>}
                </div>
              )
            })}
          </div>

          {/* Desktop Table View */}
          <div className="hidden lg:block overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
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
                  <tr key={entry.id} className="hover:bg-secondary/20 transition-colors group">
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {isEditing ? (
                        <input type="date" value={editForm.entry_date || ''} onChange={e => setEditForm(p => ({...p, entry_date: e.target.value}))} className="bg-background border rounded px-2 py-1" />
                      ) : (
                        entry.entry_date
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${entry.type === 'inflow' ? 'bg-green-400' : 'bg-red-400'}`} />
                        {isEditing ? (
                          <select value={editForm.category_id || ''} onChange={e => setEditForm(p => ({...p, category_id: e.target.value}))} className="bg-background border rounded px-2 py-1 text-xs">
                            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        ) : (
                          <span className="text-sm">{entry.category?.name || '—'}</span>
                        )}
                      </div>
                      {/* Allocation Badges */}
                      {allocStatus === 'none' && <span className="inline-block mt-1 bg-amber-500/10 text-amber-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Unallocated</span>}
                      {allocStatus === 'partial' && <span className="inline-block mt-1 bg-blue-500/10 text-blue-400 text-[9px] px-1.5 py-0.5 rounded font-medium">Partially Allocated</span>}
                      {allocStatus === 'over' && <span className="inline-block mt-1 bg-red-500/10 text-red-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Over-allocated!</span>}
                      {allocStatus === 'fully' && <span className="inline-block mt-1 bg-green-500/10 text-green-500 text-[9px] px-1.5 py-0.5 rounded font-medium">Fully Allocated</span>}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {isEditing ? (
                        <input type="text" value={editForm.description || ''} onChange={e => setEditForm(p => ({...p, description: e.target.value}))} className="bg-background border rounded px-2 py-1 w-full text-xs" />
                      ) : (
                        entry.description || '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {isEditing ? (
                        <select value={editForm.bank_account_id || ''} onChange={e => setEditForm(p => ({...p, bank_account_id: e.target.value}))} className="bg-background border rounded px-2 py-1">
                          <option value="">Cash</option>
                          {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      ) : (
                        entry.bank_account?.name || 'Cash'
                      )}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${entry.type === 'inflow' ? 'text-green-400' : 'text-red-400'}`}>
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
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {isEditing ? (
                          <>
                            <button onClick={handleInlineSave} disabled={saving} className="p-1.5 rounded-md hover:bg-primary/20 text-primary transition-colors" title="Save changes"><Save className="w-3.5 h-3.5" /></button>
                            <button onClick={() => setEditingRow(null)} disabled={saving} className="p-1.5 rounded-md hover:bg-secondary/80 text-muted-foreground transition-colors" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                          </>
                        ) : (
                          <>
                            {isInvoice && (
                              <button
                                onClick={() => setAllocatingEntry(entry)}
                                className={`lg:opacity-0 opacity-100 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-blue-500/10 ${allocStatus === 'fully' ? 'text-blue-500' : 'text-muted-foreground hover:text-blue-400'}`}
                                title="Manage allocations"
                              >
                                <LinkIcon className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {isSalary && (
                              <button
                                onClick={() => setAllocatingPayrollEntry(entry)}
                                className={`lg:opacity-0 opacity-100 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-violet-500/10 ${allocStatus === 'fully' ? 'text-violet-500' : 'text-muted-foreground hover:text-violet-400'}`}
                                title="Manage salary allocations"
                              >
                                <LinkIcon className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button onClick={() => { setEditingRow(entry.id); setEditForm(entry); }} className="lg:opacity-0 opacity-100 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground hover:text-primary" title="Edit entry">
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleSoftDelete(entry.id)}
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

      {/* Add Entry Modal */}
      {showForm && (
        <ModalOverlay onClose={() => setShowForm(false)}>
          <div className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="font-semibold">Add Cash Book Entry</h2>
              <button onClick={() => setShowForm(false)} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {/* Type toggle */}
              <div className="flex gap-2">
                {(['inflow', 'outflow'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => { setForm(p => ({ ...p, type: t, category_id: t === 'inflow' ? invoiceCategoryId : '', linked_invoice_id: '', fully_paid: false })); resetSmart() }}
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
                    onChange={id => setForm(p => ({ ...p, category_id: id }))}
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

              <div className="flex flex-col sm:grid sm:grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                    Amount *
                    {form.fully_paid && <span className="ml-2 text-green-400 font-normal">auto-filled</span>}
                  </label>
                  <input
                    type="number" min="0" step="0.01"
                    value={form.amount}
                    onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                    required
                    readOnly={form.fully_paid}
                    className={`w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 ${form.fully_paid ? 'opacity-60 cursor-not-allowed' : ''}`}
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Currency</label>
                  <AppSelect value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value as Currency }))}>
                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </AppSelect>
                </div>
              </div>

              {form.currency !== 'INR' && (
                <p className="text-xs text-muted-foreground">
                  ≈ ₹{getInrAmount(parseFloat(form.amount) || 0, form.currency).toLocaleString('en-IN', { minimumFractionDigits: 2 })} INR
                  {rateMap[form.currency] ? ` (rate: ${rateMap[form.currency]})` : ' (rate not set)'}
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">Date *</label>
                  <input type="date" value={form.entry_date} onChange={e => setForm(p => ({ ...p, entry_date: e.target.value }))} required className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                    {isInvoiceCategory ? 'Invoice' : 'Reference'}
                  </label>
                  {isInvoiceCategory ? (
                    <div className="space-y-2">
                      <Combobox
                        options={sortedDueInvoices.map(inv => {
                          const outstanding = inv.total_amount - (inv.paid_amount || 0)
                          const overdue = inv.due_date && inv.due_date < today
                          return {
                            id: inv.id,
                            label: `${overdue ? '⚠ ' : ''}${inv.invoice_number} — ${inv.client?.name}`,
                            sub: `₹${outstanding.toLocaleString('en-IN')}${overdue ? ' overdue' : inv.due_date ? ` due ${inv.due_date}` : ''}`,
                          }
                        })}
                        value={form.linked_invoice_id}
                        onChange={id => {
                          const inv = dueInvoices.find(i => i.id === id)
                          const outstanding = inv ? (inv.total_amount - (inv.paid_amount || 0)) : 0
                          setForm(p => ({
                            ...p,
                            linked_invoice_id: id,
                            fully_paid: false,
                            reference: inv?.invoice_number || '',
                            amount: outstanding > 0 ? String(outstanding) : p.amount,
                            currency: (inv?.currency as Currency) || 'INR',
                            description: inv ? `Payment for ${inv.invoice_number} — ${inv.client?.name}` : p.description,
                          }))
                        }}
                        placeholder="Select invoice…"
                      />
                      {form.linked_invoice_id && (() => {
                        const inv = dueInvoices.find(i => i.id === form.linked_invoice_id)
                        const outstanding = inv ? (inv.total_amount - (inv.paid_amount || 0)) : 0
                        return (
                          <label className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors border ${form.fully_paid ? 'bg-green-500/10 border-green-500/30' : 'bg-secondary border-transparent hover:border-border'}`}>
                            <input
                              type="checkbox"
                              checked={form.fully_paid}
                              onChange={e => {
                                const checked = e.target.checked
                                setForm(p => ({
                                  ...p,
                                  fully_paid: checked,
                                  amount: checked ? String(outstanding) : p.amount,
                                }))
                              }}
                              className="w-4 h-4 accent-green-500"
                            />
                            <div>
                              <span className="text-sm font-medium">Mark as fully paid</span>
                              <span className="text-xs text-muted-foreground ml-2">
                                — fills ₹{outstanding.toLocaleString('en-IN')} and closes the invoice
                              </span>
                            </div>
                          </label>
                        )
                      })()}
                    </div>
                  ) : (
                    <input type="text" value={form.reference} onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="e.g. INV-2505-001" />
                  )}
                </div>
              </div>

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

              {smartMode === 'salary' && (
                <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-3">
                  <p className="text-xs font-semibold text-purple-400 uppercase tracking-wide">Salary — Employee</p>
                  <Combobox
                    options={employees.map((e: any) => ({ id: e.id, label: e.cqid, sub: e.role || '' }))}
                    value={smartExtra.employee_id || ''}
                    onChange={id => {
                      const emp = employees.find((em: any) => em.id === id)
                      setSmartExtra(p => ({ ...p, employee_id: id }))
                      if (emp) setForm(p => ({ ...p, description: `Salary — ${emp.cqid}` }))
                    }}
                    placeholder="Select employee…"
                    sortKey="employees"
                  />
                </div>
              )}

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

              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Description</label>
                <input type="text" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none" placeholder="What is this for?" />
              </div>

              {/* Recurring entry */}
              <div className={`rounded-xl border p-3 transition-colors ${recurringMonths > 0 ? 'bg-violet-500/10 border-violet-500/30' : 'bg-foreground/[0.02] border-border/40'}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="recurring-toggle" checked={recurringMonths > 0}
                      onChange={e => setRecurringMonths(e.target.checked ? 3 : 0)}
                      className="w-4 h-4 rounded accent-violet-500 cursor-pointer" />
                    <label htmlFor="recurring-toggle" className="text-xs font-medium cursor-pointer select-none">
                      Repeat monthly
                    </label>
                  </div>
                  {recurringMonths > 0 && (
                    <div className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">for</span>
                      <input type="number" min={1} max={24} value={recurringMonths}
                        onChange={e => setRecurringMonths(Math.max(1, Math.min(24, parseInt(e.target.value) || 1)))}
                        className="w-12 bg-secondary border border-border rounded-md px-2 py-0.5 text-center text-xs focus:outline-none focus:border-violet-500/50" />
                      <span className="text-muted-foreground">more months</span>
                    </div>
                  )}
                </div>
                {recurringMonths > 0 && (
                  <p className="text-[10px] text-violet-400/80 mt-1.5">
                    Will create {recurringMonths + 1} entries total (this month + {recurringMonths} copies)
                  </p>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setShowForm(false); setRecurringMonths(0) }} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
                <button type="submit" disabled={saving} className={`flex-1 text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50 ${form.type === 'inflow' ? 'bg-green-600' : 'bg-red-600'}`}>
                  {saving ? 'Saving…' : recurringMonths > 0 ? `Save ${recurringMonths + 1} Entries` : `Save ${form.type === 'inflow' ? 'Income' : 'Expense'}`}
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
          amountInr={allocatingEntry.amount_inr || 0}
          dueInvoices={sortedDueInvoices}
          onClose={() => setAllocatingEntry(null)}
          onUpdate={() => window.location.reload()}
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
    </div>
  )
}
