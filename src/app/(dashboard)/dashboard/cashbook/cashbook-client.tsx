'use client'

import { useState, useMemo } from 'react'
import Header from '@/components/layout/header'
import { createClient } from '@/lib/supabase/client'
import { formatCompact } from '@/lib/calculations/currency'
import { Plus, X, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import Combobox from '@/components/ui/combobox'
import AppSelect from '@/components/ui/app-select'
import type { Currency } from '@/types'
import { ModalOverlay } from '@/components/ui/modal-overlay'

interface Entry {
  id: string
  type: 'inflow' | 'outflow'
  category_id: string
  bank_account_id?: string
  amount: number
  currency: Currency
  amount_inr: number
  entry_date: string
  description?: string
  reference?: string
  category?: { id: string; name: string; type: string }
  bank_account?: { id: string; name: string }
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
}

const CURRENCIES: Currency[] = ['INR', 'AED', 'SAR', 'USD', 'QAR', 'GBP', 'EUR']

export default function CashBookClient({ initialEntries, categories, bankAccounts, exchangeRates, dueInvoices, employees, clients, outstandingCredits }: Props) {
  const [entries, setEntries] = useState<Entry[]>(initialEntries)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterMonth, setFilterMonth] = useState('')
  const [recurringMonths, setRecurringMonths] = useState(0) // 0 = not recurring

  const invoiceCategoryId = categories.find(c => c.name?.toLowerCase() === 'invoice' && (c.type === 'inflow' || c.type === 'both'))?.id || ''

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
    }))

    const { data, error } = await supabase
      .from('cashbook_entries')
      .insert(payload)
      .select(`*, category:cashbook_categories(id, name, type), bank_account:bank_accounts(id, name)`)

    // Use first entry as "data" for legacy code below, all entries for list update
    const firstEntry = Array.isArray(data) ? data[0] : data
    const allInserted = Array.isArray(data) ? data : data ? [data] : []

    if (!error && firstEntry) {
      // Smart side-effects only run on base (first) entry
      if (smartMode === 'credit_given' && (smartExtra.entity_id || smartExtra.entity_other)) {
        await supabase.from('credit_ledger').insert({
          entity_type: smartExtra.entity_type || 'employee',
          entity_id: smartExtra.entity_id || null,
          credit_type: 'given',
          amount: parseFloat(form.amount) || 0,
          credit_date: form.entry_date,
          bank_account_id: form.bank_account_id || null,
          notes: smartExtra.entity_other
            ? `${form.description || ''}${smartExtra.entity_other ? ` (${smartExtra.entity_other})` : ''}`.trim()
            : form.description || null,
        })
      }
      if (smartMode === 'credit_return' && smartExtra.credit_id) {
        await supabase.from('credit_ledger').insert({
          entity_type: smartExtra.entity_type || 'employee',
          entity_id: smartExtra.entity_id || null,
          credit_type: 'returned',
          amount: parseFloat(form.amount) || 0,
          credit_date: form.entry_date,
          bank_account_id: form.bank_account_id || null,
          notes: form.description || null,
        })
      }

      // Mark invoice as paid/partial if linked (only on base entry)
      if (form.linked_invoice_id) {
        const inv = dueInvoices.find(i => i.id === form.linked_invoice_id)
        if (inv) {
          const newPaid = form.fully_paid
            ? inv.total_amount
            : (inv.paid_amount || 0) + (parseFloat(form.amount) || 0)
          const newStatus = form.fully_paid || newPaid >= inv.total_amount ? 'paid' : 'partial'
          await supabase.from('invoices').update({ paid_amount: newPaid, status: newStatus }).eq('id', form.linked_invoice_id)
        }
      }

      // Add all inserted entries to local state (sorted newest first)
      setEntries(prev => [...[...allInserted].reverse(), ...prev])
      setShowForm(false)
      setRecurringMonths(0)
      setForm({ type: 'inflow', category_id: invoiceCategoryId, bank_account_id: '', amount: '', currency: 'INR', entry_date: new Date().toISOString().split('T')[0], description: '', reference: '', linked_invoice_id: '', fully_paid: false })
    }
    setSaving(false)
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
    return result
  }, [entries, filterType, filterMonth])

  const totalInflow = filteredEntries.filter(e => e.type === 'inflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const totalOutflow = filteredEntries.filter(e => e.type === 'outflow').reduce((s, e) => s + (e.amount_inr || 0), 0)
  const net = totalInflow - totalOutflow

  const inflowCategories = categories.filter(c => c.type === 'inflow' || c.type === 'both')
  const outflowCategories = categories.filter(c => c.type === 'outflow' || c.type === 'both')
  const relevantCategories = form.type === 'inflow' ? inflowCategories : outflowCategories

  return (
    <div>
      <Header
        title="Cash Book"
        subtitle="Track all income and expenses"
        actions={
          <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 gradient-bg text-white text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity">
            <Plus className="w-4 h-4" />
            Add Entry
          </button>
        }
      />

      <div className="p-6 space-y-5">
        {/* Summary */}
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

        {/* Filters */}
        <div className="flex gap-3 flex-wrap items-center">
          <div className="flex gap-2">
            {['', 'inflow', 'outflow'].map(t => (
              <button key={t} onClick={() => setFilterType(t)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${filterType === t ? 'gradient-bg text-white' : 'bg-secondary text-muted-foreground hover:text-foreground'}`}>
                {t ? (t === 'inflow' ? 'Income' : 'Expense') : 'All'}
              </button>
            ))}
          </div>
          <input
            type="month"
            value={filterMonth}
            onChange={e => setFilterMonth(e.target.value)}
            className="bg-secondary border border-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {filterMonth && <button onClick={() => setFilterMonth('')} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>}
        </div>

        {/* Entries */}
        <div className="bg-card border border-border rounded-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[600px]">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Date</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Category</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Description</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Account</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredEntries.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">No entries found</td></tr>
              )}
              {filteredEntries.map(entry => (
                <tr key={entry.id} className="hover:bg-secondary/20 transition-colors">
                  <td className="px-4 py-3 text-muted-foreground text-xs">{entry.entry_date}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${entry.type === 'inflow' ? 'bg-green-400' : 'bg-red-400'}`} />
                      <span className="text-sm">{entry.category?.name || '—'}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">{entry.description || '—'}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{entry.bank_account?.name || 'Cash'}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${entry.type === 'inflow' ? 'text-green-400' : 'text-red-400'}`}>
                    {entry.type === 'inflow' ? '+' : '-'}₹{(entry.amount_inr || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    {entry.currency !== 'INR' && <span className="text-xs text-muted-foreground ml-1">({entry.currency} {entry.amount?.toLocaleString()})</span>}
                  </td>
                </tr>
              ))}
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
    </div>
  )
}
