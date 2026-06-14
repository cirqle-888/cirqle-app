'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, ShoppingBag, Trash2, AlertCircle, Tag } from 'lucide-react'

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

export interface ExpenseItem {
  id: string
  cashbook_entry_id: string
  description: string
  amount: number          // billing amount (client sees this)
  amount_inr: number
  currency: string
  original_amount?: number
  original_amount_inr?: number
  markup_type?: string
  markup_value?: number
  markup_amount?: number
  notes?: string | null
}

type MarkupType = 'none' | 'percentage' | 'fixed'

interface SelectionState {
  desc: string
  notes: string
  markupType: MarkupType
  markupValue: string   // raw input (% or fixed amount in invoice currency)
  originalAmt: number   // in invoice currency
}

interface Props {
  invoiceId: string
  invoiceNumber: string
  clientId: string
  clientName?: string
  invoiceCurrency: string
  exchangeRate: number
  existingExpenses: ExpenseItem[]
  canMarkup: boolean       // only super_admin / accounts can set markup
  onClose: () => void
  onUpdate: () => void
}

const r2 = (n: number) => Math.round(n * 100) / 100
const fmt = (n: number, c = 'INR') =>
  (c === 'INR' ? '₹' : c + ' ') + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
function ddMon(d?: string) {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function computeBilling(state: SelectionState): { billing: number; markupAmt: number } {
  const orig = state.originalAmt
  if (state.markupType === 'percentage') {
    const pct = parseFloat(state.markupValue) || 0
    const markupAmt = r2(orig * pct / 100)
    return { billing: r2(orig + markupAmt), markupAmt }
  }
  if (state.markupType === 'fixed') {
    const markupAmt = parseFloat(state.markupValue) || 0
    return { billing: r2(orig + markupAmt), markupAmt: r2(markupAmt) }
  }
  return { billing: orig, markupAmt: 0 }
}

export default function AddExpenseModal({
  invoiceId, invoiceNumber, clientId, clientName, invoiceCurrency, exchangeRate,
  existingExpenses, canMarkup, onClose, onUpdate,
}: Props) {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState<CashbookExpenseEntry[]>([])
  const [selections, setSelections] = useState<Record<string, SelectionState>>({})

  useEffect(() => { void load() /* eslint-disable-next-line */ }, [])

  async function load() {
    setLoading(true)
    setError('')
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
    setAvailable(billedIds.length ? rows.filter(r => !billedIds.includes(r.id)) : rows)
    setLoading(false)
  }

  function toggle(entry: CashbookExpenseEntry) {
    setSelections(prev => {
      if (prev[entry.id]) {
        const next = { ...prev }; delete next[entry.id]; return next
      }
      const originalAmt = invoiceCurrency !== 'INR' && exchangeRate > 0
        ? r2(entry.amount_inr / exchangeRate)
        : entry.amount_inr
      return {
        ...prev,
        [entry.id]: {
          desc: entry.description || entry.category?.name || 'Expense',
          notes: '',
          markupType: 'none',
          markupValue: '',
          originalAmt,
        },
      }
    })
  }

  function updateSel(entryId: string, patch: Partial<SelectionState>) {
    setSelections(prev => ({ ...prev, [entryId]: { ...prev[entryId], ...patch } }))
  }

  async function handleAdd() {
    const toAdd = Object.entries(selections)
    if (!toAdd.length) return
    setSaving(true)
    setError('')

    const rows = toAdd.map(([entryId, sel]) => {
      const { billing, markupAmt } = computeBilling(sel)
      const billingInr = invoiceCurrency === 'INR' ? billing : r2(billing * (exchangeRate || 1))
      const originalInr = invoiceCurrency === 'INR' ? sel.originalAmt : r2(sel.originalAmt * (exchangeRate || 1))
      const markupVal = sel.markupType !== 'none' ? (parseFloat(sel.markupValue) || 0) : 0
      return {
        invoice_id: invoiceId,
        cashbook_entry_id: entryId,
        description: sel.desc.trim() || 'Expense',
        notes: sel.notes.trim() || null,
        amount: billing,
        amount_inr: billingInr,
        currency: invoiceCurrency,
        original_amount: sel.originalAmt,
        original_amount_inr: originalInr,
        markup_type: sel.markupType,
        markup_value: markupVal,
        markup_amount: markupAmt,
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
      <div className="flex flex-col h-full max-h-[90vh] w-full max-w-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border/40 shrink-0">
          <div>
            <div className="flex items-center gap-2 font-semibold text-sm">
              <ShoppingBag className="w-4 h-4 text-amber-400" />
              Add Client Expenses
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{invoiceNumber} · {clientName}</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-foreground/10"><X className="w-4 h-4" /></button>
        </div>

        {/* Existing expenses */}
        {existingExpenses.length > 0 && (
          <div className="px-4 pt-3 pb-2 shrink-0">
            <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
              On this invoice
            </div>
            <div className="space-y-1">
              {existingExpenses.map(exp => {
                const hasMarkup = exp.markup_type && exp.markup_type !== 'none' && (exp.markup_amount || 0) > 0
                return (
                  <div key={exp.id} className="flex items-center gap-2 text-xs bg-foreground/[0.04] border border-border/30 rounded-lg px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-foreground/80 truncate">{exp.description}</div>
                      {hasMarkup && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Cost {fmt(exp.original_amount || 0, exp.currency)} + markup {fmt(exp.markup_amount || 0, exp.currency)} = {fmt(exp.amount, exp.currency)}
                        </div>
                      )}
                      {exp.notes && <div className="text-[10px] text-muted-foreground italic mt-0.5">{exp.notes}</div>}
                    </div>
                    <span className="font-mono font-semibold text-amber-300/90 shrink-0">{fmt(exp.amount, exp.currency)}</span>
                    <button onClick={() => handleRemove(exp.id)} disabled={saving}
                      className="text-red-400 hover:text-red-300 shrink-0 disabled:opacity-40">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Available entries */}
        <div className="flex-1 overflow-y-auto px-4 pt-2 pb-2">
          {loading ? (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">Loading…</div>
          ) : available.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 gap-2 text-muted-foreground">
              <ShoppingBag className="w-6 h-6 opacity-30" />
              <span className="text-sm">No unbilled outflow entries for {clientName}</span>
              <span className="text-xs opacity-60">Tag cashbook outflows to this client to bill them here</span>
            </div>
          ) : (
            <>
              <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Unbilled outflows — {clientName}
              </div>
              <div className="space-y-2">
                {available.map(entry => {
                  const selected = !!selections[entry.id]
                  const sel = selections[entry.id]
                  const { billing, markupAmt } = sel ? computeBilling(sel) : { billing: 0, markupAmt: 0 }
                  return (
                    <div key={entry.id}
                      className={`border rounded-xl transition-colors ${selected
                        ? 'border-amber-500/50 bg-amber-500/5'
                        : 'border-border/30 bg-foreground/[0.02] hover:border-border/60'}`}>
                      {/* Entry row */}
                      <div className="flex items-start gap-3 p-3 cursor-pointer" onClick={() => toggle(entry)}>
                        <input type="checkbox" checked={selected} onChange={() => toggle(entry)}
                          onClick={e => e.stopPropagation()} className="mt-0.5 shrink-0 accent-amber-500" />
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap gap-1 mb-0.5">
                            {entry.category && (
                              <span className="text-[10px] bg-foreground/10 text-muted-foreground px-1.5 py-0.5 rounded-full">
                                {entry.category.name}
                              </span>
                            )}
                            <span className="text-[10px] text-muted-foreground">{ddMon(entry.entry_date)}</span>
                          </div>
                          <div className="text-xs text-foreground/80 truncate">{entry.description || '(no description)'}</div>
                        </div>
                        <div className="text-xs font-mono font-medium shrink-0 mt-1">{fmt(entry.amount_inr)}</div>
                      </div>

                      {/* Markup + description fields when selected */}
                      {selected && (
                        <div className="px-3 pb-3 space-y-3 border-t border-amber-500/20">
                          {/* Description */}
                          <div className="pt-2">
                            <label className="text-[10px] text-muted-foreground">Bill as (description)</label>
                            <input type="text" value={sel.desc}
                              onChange={e => updateSel(entry.id, { desc: e.target.value })}
                              onClick={e => e.stopPropagation()}
                              className="w-full mt-0.5 bg-background border border-border/40 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-amber-500/50"
                              placeholder="Description on invoice" />
                          </div>

                          {/* Markup (gated) */}
                          {canMarkup ? (
                            <div>
                              <label className="text-[10px] text-muted-foreground font-medium flex items-center gap-1">
                                <Tag className="w-3 h-3" />Markup
                              </label>
                              <div className="flex gap-2 mt-1 flex-wrap">
                                {(['none', 'percentage', 'fixed'] as MarkupType[]).map(type => (
                                  <button key={type}
                                    onClick={e => { e.stopPropagation(); updateSel(entry.id, { markupType: type, markupValue: '' }) }}
                                    className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${sel.markupType === type
                                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                      : 'border-border/40 text-muted-foreground hover:border-border/70'}`}>
                                    {type === 'none' ? 'No markup' : type === 'percentage' ? '% Percentage' : 'Fixed amount'}
                                  </button>
                                ))}
                              </div>

                              {sel.markupType !== 'none' && (
                                <div className="flex gap-3 mt-2 items-end">
                                  <div>
                                    <label className="text-[10px] text-muted-foreground">
                                      {sel.markupType === 'percentage' ? 'Markup %' : `Markup amount (${invoiceCurrency})`}
                                    </label>
                                    <div className="flex items-center gap-1 mt-0.5">
                                      <input type="number" min="0" step={sel.markupType === 'percentage' ? '0.5' : '1'}
                                        value={sel.markupValue}
                                        onChange={e => { e.stopPropagation(); updateSel(entry.id, { markupValue: e.target.value }) }}
                                        onClick={e => e.stopPropagation()}
                                        className="w-24 bg-background border border-border/40 rounded-lg px-2.5 py-1.5 text-xs text-right font-mono focus:outline-none focus:border-amber-500/50"
                                        placeholder={sel.markupType === 'percentage' ? '20' : '200'} />
                                      {sel.markupType === 'percentage' && <span className="text-xs text-muted-foreground">%</span>}
                                    </div>
                                  </div>
                                  {/* Live preview */}
                                  <div className="text-xs pb-0.5">
                                    <div className="text-muted-foreground">
                                      {fmt(sel.originalAmt, invoiceCurrency)} + {fmt(markupAmt, invoiceCurrency)}
                                    </div>
                                    <div className="font-semibold text-amber-300 text-sm mt-0.5">
                                      = {fmt(billing, invoiceCurrency)}
                                    </div>
                                  </div>
                                </div>
                              )}

                              {sel.markupType === 'none' && (
                                <div className="mt-1.5 text-[10px] text-muted-foreground">
                                  Billing: <span className="font-mono font-medium text-foreground/70">{fmt(sel.originalAmt, invoiceCurrency)}</span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-[10px] text-muted-foreground">
                              Billing amount: <span className="font-mono">{fmt(sel.originalAmt, invoiceCurrency)}</span>
                              <span className="ml-2 opacity-60">(Admin/Finance can add markup)</span>
                            </div>
                          )}

                          {/* Notes */}
                          <div>
                            <label className="text-[10px] text-muted-foreground">Notes (internal)</label>
                            <input type="text" value={sel.notes}
                              onChange={e => updateSel(entry.id, { notes: e.target.value })}
                              onClick={e => e.stopPropagation()}
                              className="w-full mt-0.5 bg-background border border-border/40 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-amber-500/50"
                              placeholder="Internal note…" />
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
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 p-4 border-t border-border/40 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-lg border border-border/40 hover:border-border transition-colors">
            Cancel
          </button>
          <button onClick={handleAdd} disabled={saving || selectedCount === 0}
            className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors">
            {saving ? 'Adding…' : selectedCount > 0 ? `Add ${selectedCount} Expense${selectedCount > 1 ? 's' : ''}` : 'Add Expenses'}
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}
