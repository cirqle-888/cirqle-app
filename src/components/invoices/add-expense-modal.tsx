'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, ShoppingBag, Trash2, AlertCircle } from 'lucide-react'

interface CashbookExpenseEntry {
  id: string
  entry_date: string
  description: string | null
  category: { name: string } | null
  amount: number
  amount_inr: number
  currency: string | null
  reference: string | null
}

interface ExpenseItem {
  id: string
  cashbook_entry_id: string
  description: string
  amount: number
  amount_inr: number
  currency: string
}

interface Props {
  invoiceId: string
  invoiceNumber: string
  clientId: string
  clientName?: string
  invoiceCurrency: string
  exchangeRate: number
  existingExpenses: ExpenseItem[]
  onClose: () => void
  onUpdate: () => void
}

const fmt = (n: number, c = 'INR') =>
  (c === 'INR' ? '₹' : c + ' ') + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function ddMon(d?: string) {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function AddExpenseModal({
  invoiceId, invoiceNumber, clientId, clientName, invoiceCurrency, exchangeRate,
  existingExpenses, onClose, onUpdate,
}: Props) {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState<CashbookExpenseEntry[]>([])

  // selections: entryId → { description, amount (in invoice currency) }
  const [selections, setSelections] = useState<Record<string, { desc: string; amount: string }>>({})

  useEffect(() => { void load() /* eslint-disable-next-line */ }, [])

  async function load() {
    setLoading(true)
    setError('')
    // Load all client outflow entries that are NOT already in invoice_expense_items
    const billedIds = existingExpenses.map(e => e.cashbook_entry_id)

    const { data, error: err } = await supabase
      .from('cashbook_entries')
      .select('id, entry_date, description, amount, amount_inr, currency, reference, category:cashbook_categories(name)')
      .eq('client_id', clientId)
      .eq('type', 'outflow')
      .is('deleted_at', null)
      .order('entry_date', { ascending: false })

    if (err) { setError(err.message); setLoading(false); return }

    const rows = (data || []) as unknown as CashbookExpenseEntry[]
    // Exclude already-billed entries
    setAvailable(billedIds.length ? rows.filter(r => !billedIds.includes(r.id)) : rows)
    setLoading(false)
  }

  function toggle(entry: CashbookExpenseEntry) {
    setSelections(prev => {
      if (prev[entry.id]) {
        const next = { ...prev }
        delete next[entry.id]
        return next
      }
      // Default: bill in INR at original amount; convert if invoice is foreign
      const amountInInvCcy = invoiceCurrency !== 'INR' && exchangeRate > 0
        ? Math.round((entry.amount_inr / exchangeRate) * 100) / 100
        : entry.amount_inr
      return {
        ...prev,
        [entry.id]: {
          desc: entry.description || entry.category?.name || 'Expense',
          amount: String(amountInInvCcy),
        },
      }
    })
  }

  async function handleAdd() {
    const toAdd = Object.entries(selections)
    if (!toAdd.length) return
    setSaving(true)
    setError('')

    const rows = toAdd.map(([entryId, sel]) => {
      const amtNum = parseFloat(sel.amount) || 0
      const amtInr = invoiceCurrency === 'INR' ? amtNum : Math.round(amtNum * (exchangeRate || 1) * 100) / 100
      return {
        invoice_id: invoiceId,
        cashbook_entry_id: entryId,
        description: sel.desc.trim() || 'Expense',
        amount: amtNum,
        amount_inr: amtInr,
        currency: invoiceCurrency,
      }
    })

    const { error: err } = await supabase.from('invoice_expense_items').insert(rows)
    if (err) { setError(err.message); setSaving(false); return }
    onUpdate()
    onClose()
  }

  async function handleRemove(itemId: string) {
    setSaving(true)
    const { error: err } = await supabase.from('invoice_expense_items').delete().eq('id', itemId)
    if (err) { setError(err.message); setSaving(false); return }
    onUpdate()
  }

  const selectedCount = Object.keys(selections).length

  return (
    <ModalOverlay onClose={onClose}>
      <div className="flex flex-col h-full max-h-[90vh] w-full max-w-lg">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border/40 shrink-0">
          <div>
            <div className="flex items-center gap-2 font-semibold text-sm">
              <ShoppingBag className="w-4 h-4 text-violet-400" />
              Add Client Expenses
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {invoiceNumber} · {clientName}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-foreground/10">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Existing expenses on this invoice */}
        {existingExpenses.length > 0 && (
          <div className="px-4 pt-3 pb-1 shrink-0">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              Already on this invoice
            </div>
            <div className="space-y-1">
              {existingExpenses.map(exp => (
                <div key={exp.id} className="flex items-center gap-2 text-xs bg-foreground/[0.04] border border-border/30 rounded-lg px-3 py-2">
                  <span className="flex-1 text-foreground/80 truncate">{exp.description}</span>
                  <span className="font-mono text-foreground/60 shrink-0">{fmt(exp.amount, exp.currency)}</span>
                  <button
                    onClick={() => handleRemove(exp.id)}
                    disabled={saving}
                    className="text-red-400 hover:text-red-300 shrink-0 disabled:opacity-40"
                    title="Remove from invoice"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Available entries */}
        <div className="flex-1 overflow-y-auto px-4 pt-3 pb-2">
          {loading ? (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">Loading…</div>
          ) : available.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 gap-2 text-muted-foreground">
              <ShoppingBag className="w-6 h-6 opacity-30" />
              <span className="text-sm">No unbilled outflow entries for {clientName}</span>
              <span className="text-xs opacity-60">Tag cashbook outflow entries to this client to bill them here</span>
            </div>
          ) : (
            <>
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Unbilled outflows — {clientName}
              </div>
              <div className="space-y-1.5">
                {available.map(entry => {
                  const selected = !!selections[entry.id]
                  const sel = selections[entry.id]
                  return (
                    <div key={entry.id}
                      className={`border rounded-lg transition-colors ${selected
                        ? 'border-violet-500/50 bg-violet-500/5'
                        : 'border-border/30 bg-foreground/[0.02] hover:border-border/60'}`}>
                      {/* Entry row */}
                      <div
                        className="flex items-start gap-3 p-2.5 cursor-pointer"
                        onClick={() => toggle(entry)}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggle(entry)}
                          onClick={e => e.stopPropagation()}
                          className="mt-0.5 shrink-0 accent-violet-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {entry.category && (
                              <span className="text-[10px] bg-foreground/10 text-muted-foreground px-1.5 py-0.5 rounded-full">
                                {entry.category.name}
                              </span>
                            )}
                            <span className="text-[10px] text-muted-foreground">{ddMon(entry.entry_date)}</span>
                          </div>
                          <div className="text-xs text-foreground/80 mt-0.5 truncate">
                            {entry.description || '(no description)'}
                          </div>
                          {entry.reference && (
                            <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{entry.reference}</div>
                          )}
                        </div>
                        <div className="text-xs font-mono font-medium shrink-0 mt-0.5">
                          {fmt(entry.amount_inr)}
                        </div>
                      </div>

                      {/* Editable fields when selected */}
                      {selected && (
                        <div className="px-3 pb-2.5 pt-0 space-y-2 border-t border-violet-500/20">
                          <div className="flex gap-2 pt-2">
                            <div className="flex-1">
                              <label className="text-[10px] text-muted-foreground">Bill as</label>
                              <input
                                type="text"
                                value={sel.desc}
                                onChange={e => setSelections(p => ({ ...p, [entry.id]: { ...p[entry.id], desc: e.target.value } }))}
                                onClick={e => e.stopPropagation()}
                                className="w-full mt-0.5 bg-background border border-border/40 rounded px-2 py-1 text-xs focus:outline-none focus:border-violet-500/50"
                                placeholder="Description on invoice"
                              />
                            </div>
                            <div className="w-28">
                              <label className="text-[10px] text-muted-foreground">
                                Amount ({invoiceCurrency})
                              </label>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={sel.amount}
                                onChange={e => setSelections(p => ({ ...p, [entry.id]: { ...p[entry.id], amount: e.target.value } }))}
                                onClick={e => e.stopPropagation()}
                                className="w-full mt-0.5 bg-background border border-border/40 rounded px-2 py-1 text-xs text-right font-mono focus:outline-none focus:border-violet-500/50"
                              />
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mx-4 mb-2 flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2.5 shrink-0">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 p-4 border-t border-border/40 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg border border-border/40 hover:border-border transition-colors">
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={saving || selectedCount === 0}
            className="px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors">
            {saving ? 'Adding…' : selectedCount > 0 ? `Add ${selectedCount} Expense${selectedCount > 1 ? 's' : ''}` : 'Add Expenses'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
