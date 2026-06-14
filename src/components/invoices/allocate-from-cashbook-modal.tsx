'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, ShieldAlert, Trash2, Link2, Wallet, ArrowRight } from 'lucide-react'

/**
 * Invoice-side entry point into the EXISTING cashbook→invoice allocation engine.
 *
 * It writes the very same `cashbook_invoice_allocations` rows the Cash Book
 * "Manage Allocations" modal writes ({cashbook_entry_id, invoice_id,
 * allocated_amount}, soft-deleted via deleted_at). The DB triggers on that table
 * recalculate the invoice's paid_amount/status and the entry's allocated balance,
 * so no payment/allocation logic is duplicated here — this is purely an alternate
 * UI. All amounts are in INR (the base currency allocations are denominated in).
 */

interface CashEntry {
  id: string
  entry_date: string
  reference: string | null
  description: string | null
  amount_inr: number
  currency: string | null
  allocatedTotal: number        // Σ of all non-deleted allocations on this entry
  available: number             // amount_inr − allocatedTotal
  thisInvoiceAllocId?: string    // existing allocation row linking this entry → this invoice
  thisInvoiceAmount: number      // amount already allocated from this entry to this invoice
}

interface Props {
  invoiceId: string
  invoiceNumber: string
  clientId: string
  clientName?: string
  /** Invoice balance still due, in INR — the hard cap for new allocations. */
  balanceDueInr: number
  onClose: () => void
  /** Called after a successful save/remove so the parent can resync from the DB. */
  onUpdate: () => void
}

const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function AllocateFromCashbookModal({
  invoiceId, invoiceNumber, clientId, clientName, balanceDueInr, onClose, onUpdate,
}: Props) {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [entries, setEntries] = useState<CashEntry[]>([])
  // entryId → amount string the user wants to allocate NOW (on top of any existing).
  const [inputs, setInputs] = useState<Record<string, string>>({})

  useEffect(() => { void load() /* eslint-disable-next-line */ }, [])

  async function load() {
    setLoading(true)
    setError('')
    // 1. This client's inflow entries.
    const { data: rawEntries, error: e1 } = await supabase
      .from('cashbook_entries')
      .select('id, entry_date, reference, description, amount_inr, currency')
      .eq('type', 'inflow')
      .eq('client_id', clientId)
      .is('deleted_at', null)
      .order('entry_date', { ascending: true })

    if (e1) { setError(e1.message); setLoading(false); return }
    const ids = (rawEntries || []).map(r => r.id)

    // 2. All non-deleted allocations on those entries (to compute available balance).
    let allocs: { id: string; cashbook_entry_id: string; invoice_id: string; allocated_amount: number }[] = []
    if (ids.length) {
      const { data: allocData, error: e2 } = await supabase
        .from('cashbook_invoice_allocations')
        .select('id, cashbook_entry_id, invoice_id, allocated_amount')
        .in('cashbook_entry_id', ids)
        .is('deleted_at', null)
      if (e2) { setError(e2.message); setLoading(false); return }
      allocs = allocData || []
    }

    const built: CashEntry[] = (rawEntries || []).map(r => {
      const mine = allocs.filter(a => a.cashbook_entry_id === r.id)
      const allocatedTotal = round2(mine.reduce((s, a) => s + Number(a.allocated_amount || 0), 0))
      const thisInv = mine.find(a => a.invoice_id === invoiceId)
      const total = Number(r.amount_inr || 0)
      return {
        id: r.id,
        entry_date: r.entry_date,
        reference: r.reference,
        description: r.description,
        amount_inr: total,
        currency: r.currency,
        allocatedTotal,
        available: round2(total - allocatedTotal),
        thisInvoiceAllocId: thisInv?.id,
        thisInvoiceAmount: round2(thisInv ? Number(thisInv.allocated_amount || 0) : 0),
      }
    })
    // Keep entries that still have something to give, or are already linked here.
    setEntries(built.filter(e => e.available > 0.01 || e.thisInvoiceAllocId))
    setLoading(false)
  }

  // Sum the user is trying to allocate this round.
  const enteredTotal = useMemo(
    () => round2(Object.values(inputs).reduce((s, v) => s + (parseFloat(v) || 0), 0)),
    [inputs],
  )
  // Remaining invoice balance after the amounts typed so far.
  const remainingAfter = round2(balanceDueInr - enteredTotal)

  function setInput(entryId: string, value: string) {
    setError('')
    setInputs(prev => ({ ...prev, [entryId]: value }))
  }

  // Fill an entry's input with the largest valid amount (min of its available and
  // the invoice balance still unallocated by the other inputs).
  function fillMax(entry: CashEntry) {
    const otherEntered = round2(enteredTotal - (parseFloat(inputs[entry.id] || '0') || 0))
    const invoiceRoom = round2(balanceDueInr - otherEntered)
    const give = round2(Math.max(0, Math.min(entry.available, invoiceRoom)))
    setInput(entry.id, give > 0 ? String(give) : '')
  }

  async function handleSave() {
    setError('')
    const rows = entries
      .map(e => ({ entry: e, amt: round2(parseFloat(inputs[e.id] || '0') || 0) }))
      .filter(r => r.amt > 0.01)

    if (rows.length === 0) { setError('Enter an amount to allocate on at least one entry.'); return }

    // Per-entry cap: cannot exceed that entry's available balance.
    for (const { entry, amt } of rows) {
      if (amt > entry.available + 0.01) {
        setError(`${inr(amt)} exceeds the ${inr(entry.available)} available on the ${entry.entry_date} entry.`)
        return
      }
    }
    // Invoice cap: total new allocation cannot exceed the balance due.
    const sum = round2(rows.reduce((s, r) => s + r.amt, 0))
    if (sum > balanceDueInr + 0.01) {
      setError(`Total ${inr(sum)} exceeds the invoice balance due of ${inr(balanceDueInr)}.`)
      return
    }

    setSaving(true)
    try {
      // Add onto an existing link for this (entry, invoice); otherwise insert.
      const toInsert = rows
        .filter(r => !r.entry.thisInvoiceAllocId)
        .map(r => ({ cashbook_entry_id: r.entry.id, invoice_id: invoiceId, allocated_amount: r.amt }))

      for (const r of rows.filter(r => r.entry.thisInvoiceAllocId)) {
        const { error: e } = await supabase
          .from('cashbook_invoice_allocations')
          .update({ allocated_amount: round2(r.entry.thisInvoiceAmount + r.amt) })
          .eq('id', r.entry.thisInvoiceAllocId!)
        if (e) { setError(e.message); setSaving(false); return }
      }
      if (toInsert.length) {
        const { error: e } = await supabase.from('cashbook_invoice_allocations').insert(toInsert)
        if (e) { setError(e.message); setSaving(false); return }
      }
      onUpdate()
    } catch (e: any) {
      setError(e?.message || 'Failed to save allocations.')
      setSaving(false)
    }
  }

  async function handleRemove(allocId: string) {
    if (!confirm('Remove this allocation? The payment goes back to unallocated.')) return
    setSaving(true)
    const { error: e } = await supabase
      .from('cashbook_invoice_allocations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', allocId)
    if (e) { setError(e.message); setSaving(false); return }
    onUpdate()
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-border bg-secondary/30">
          <div className="min-w-0">
            <h2 className="font-semibold flex items-center gap-2"><Wallet className="w-4 h-4 text-violet-400" />Allocate From Cash Book</h2>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {invoiceNumber}{clientName ? ` · ${clientName}` : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0"><X className="w-4 h-4" /></button>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 px-5 sm:px-6 pt-5">
          <div className="bg-secondary/50 border border-border rounded-lg p-3 text-center">
            <p className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground mb-1">Balance Due</p>
            <p className="font-mono text-lg font-bold">{inr(balanceDueInr)}</p>
          </div>
          <div className={`border rounded-lg p-3 text-center ${remainingAfter < -0.01 ? 'bg-red-500/10 border-red-500/20 text-red-500' : remainingAfter < 0.01 ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-amber-500/10 border-amber-500/20 text-amber-500'}`}>
            <p className="text-[10px] uppercase font-semibold tracking-wider mb-1">Remaining After</p>
            <p className="font-mono text-lg font-bold">{inr(remainingAfter)}</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 sm:px-6 py-5 flex-1 overflow-y-auto space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-sm">
              <ShieldAlert className="w-4 h-4 shrink-0" /><p>{error}</p>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground animate-pulse py-8 text-center">Loading cash book entries…</p>
          ) : entries.length === 0 ? (
            <div className="text-center py-10 bg-secondary/30 rounded-lg border border-border border-dashed">
              <Wallet className="w-6 h-6 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No available Cash Book payments for {clientName || 'this client'}.</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Record the inflow in Cash Book first, then allocate it here.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {entries.map(e => {
                const linked = !!e.thisInvoiceAllocId
                return (
                  <div key={e.id} className="border border-border rounded-xl p-3 bg-secondary/20">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{e.entry_date}</span>
                          {e.reference && (
                            <span className="text-[10px] font-mono bg-foreground/[0.06] border border-border/40 px-1.5 py-0.5 rounded">{e.reference}</span>
                          )}
                          {linked && (
                            <span className="inline-flex items-center gap-1 text-[10px] bg-green-500/10 text-green-500 px-1.5 py-0.5 rounded font-medium">
                              <Link2 className="w-2.5 h-2.5" />Linked {inr(e.thisInvoiceAmount)}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate">{e.description || '—'}</p>
                      </div>
                      {linked && (
                        <button
                          onClick={() => handleRemove(e.thisInvoiceAllocId!)}
                          disabled={saving}
                          title="Remove this allocation"
                          className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50 shrink-0">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-2 mt-2.5 text-[11px]">
                      <div><span className="text-muted-foreground block">Total</span><span className="font-mono">{inr(e.amount_inr)}</span></div>
                      <div><span className="text-muted-foreground block">Allocated</span><span className="font-mono">{inr(e.allocatedTotal)}</span></div>
                      <div><span className="text-muted-foreground block">Available</span><span className="font-mono text-amber-500">{inr(e.available)}</span></div>
                    </div>

                    <div className="flex items-center gap-2 mt-3">
                      <div className="flex items-center gap-1 flex-1">
                        <span className="text-xs text-muted-foreground">Allocate ₹</span>
                        <input
                          type="number" min="0" step="0.01" inputMode="decimal"
                          value={inputs[e.id] || ''}
                          onChange={ev => setInput(e.id, ev.target.value)}
                          placeholder="0.00"
                          className="flex-1 min-w-0 bg-background border border-border/40 rounded-lg px-2.5 py-1.5 text-sm font-mono focus:outline-none focus:border-violet-500/50"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => fillMax(e)}
                        className="text-[11px] font-medium text-violet-400 hover:text-violet-300 px-2 py-1.5 rounded-lg hover:bg-violet-500/10 transition-colors whitespace-nowrap">
                        Max
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-t border-border bg-secondary/20">
          <p className="text-xs text-muted-foreground">
            Allocating <span className="font-mono font-semibold text-foreground">{inr(enteredTotal)}</span>
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm rounded-lg hover:bg-secondary/80 text-muted-foreground transition-colors disabled:opacity-50">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving || loading || enteredTotal <= 0.01 || remainingAfter < -0.01}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              {saving ? 'Saving…' : <>Allocate <ArrowRight className="w-3.5 h-3.5" /></>}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
