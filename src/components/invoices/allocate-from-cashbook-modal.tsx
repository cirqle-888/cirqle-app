'use client'

import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
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
  /** Invoice balance still due, in INR — the hard cap for new allocations.
   *  (Allocations are always in ₹; the DB trigger converts ₹ ÷ exchangeRate back
   *  into the invoice currency to set paid_amount/status.) */
  balanceDueInr: number
  /** Invoice billing currency, e.g. 'AED'. Defaults to INR. */
  invoiceCurrency?: string
  /** rate_to_inr stamped on the invoice (₹ per 1 unit of invoiceCurrency). */
  exchangeRate?: number
  /** Invoice balance still due in the INVOICE currency (for display + settle-in-full). */
  balanceDueNative?: number
  /** Today's market rate (₹ per unit) for the invoice currency — used to show the
   *  realized FX variance when settling a foreign invoice in full. */
  marketRate?: number
  /** True when this invoice has no settlement yet (paid = 0). Settle-in-full only
   *  applies to a clean, unsettled foreign invoice. */
  unsettled?: boolean
  onClose: () => void
  /** Called after a successful save/remove so the parent can resync from the DB. */
  onUpdate: () => void
}

const round2 = (n: number) => Math.round(n * 100) / 100
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const ccy = (n: number, c: string) => `${c} ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function AllocateFromCashbookModal({
  invoiceId, invoiceNumber, clientId, clientName, balanceDueInr,
  invoiceCurrency = 'INR', exchangeRate, balanceDueNative, marketRate, unsettled, onClose, onUpdate,
}: Props) {
  // Foreign-currency invoice paid from an INR cash book. The trigger converts
  // ₹allocated ÷ exchangeRate → invoice currency. If the invoice never got an FX
  // rate stamped (rate 1 on a non-INR invoice), its ₹ balance is the raw foreign
  // figure (e.g. AED 120 shown as ₹120) and allocating would settle it at 1:1.
  const isForeign = invoiceCurrency !== 'INR'
  const rateUnset = isForeign && (!exchangeRate || exchangeRate === 1)
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

  // ── Settle-in-full (foreign invoice, cash-basis FX) ──────────────────────────
  // For a foreign invoice settled by an INR payment, the ₹ received rarely equals
  // foreign × today's rate. "Settle in full" books the invoice at the REALIZED
  // rate (₹received ÷ foreign balance) so it flips to Paid with revenue = the ₹
  // you actually got. The FX variance vs the market rate is shown for awareness —
  // it is NOT posted as a separate expense (that would double-count income on a
  // cash-basis book).
  const canSettleInFull = isForeign && !rateUnset && !!unsettled && (balanceDueNative ?? 0) > 0
  const realizedRate = canSettleInFull && enteredTotal > 0.01
    ? Math.round((enteredTotal / (balanceDueNative as number)) * 1e6) / 1e6
    : 0
  // Negative = FX loss (received less than the foreign amount is worth at market).
  const fxVariance = canSettleInFull && enteredTotal > 0.01 && (marketRate ?? 0) > 0
    ? round2(enteredTotal - (balanceDueNative as number) * (marketRate as number))
    : 0

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

  // Settle the foreign invoice in full at the realized rate, then allocate the cash.
  async function handleSettleInFull() {
    setError('')
    const rows = entries
      .map(e => ({ entry: e, amt: round2(parseFloat(inputs[e.id] || '0') || 0) }))
      .filter(r => r.amt > 0.01)
    if (rows.length === 0) { setError('Enter the ₹ amount received before settling in full.'); return }
    for (const { entry, amt } of rows) {
      if (amt > entry.available + 0.01) {
        setError(`${inr(amt)} exceeds the ${inr(entry.available)} available on the ${entry.entry_date} entry.`)
        return
      }
    }
    if (!realizedRate || realizedRate <= 0) { setError('Cannot compute a realized rate.'); return }

    setSaving(true)
    try {
      // 1. Re-stamp the invoice at the realized rate FIRST, so the allocation
      //    trigger (paid = ₹allocated ÷ rate) computes a fully-paid invoice.
      const { error: rErr } = await supabase
        .from('invoices')
        .update({ exchange_rate: realizedRate })
        .eq('id', invoiceId)
      if (rErr) { setError(`Could not update invoice rate: ${rErr.message}`); setSaving(false); return }

      // 2. Allocate the cash (insert new / add onto existing).
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
      setError(e?.message || 'Failed to settle invoice.')
      setSaving(false)
    }
  }

  // In-app confirmation. NOT window.confirm: the desktop shell returns false
  // from it immediately without ever drawing a dialog, so this button would
  // silently do nothing there.
  const [removeAllocId, setRemoveAllocId] = useState<string | null>(null)

  async function handleRemove(allocId: string) {
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
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88dvh]">
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
            {isForeign ? (
              <>
                <p className="font-mono text-lg font-bold">{ccy(balanceDueNative ?? balanceDueInr, invoiceCurrency)}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                  ≈ {inr(balanceDueInr)} @ {Number(exchangeRate || 1).toLocaleString('en-IN')}
                </p>
              </>
            ) : (
              <p className="font-mono text-lg font-bold">{inr(balanceDueInr)}</p>
            )}
          </div>
          <div className={`border rounded-lg p-3 text-center ${remainingAfter < -0.01 ? 'bg-red-500/10 border-red-500/20 text-red-500' : remainingAfter < 0.01 ? 'bg-green-500/10 border-green-500/20 text-green-500' : 'bg-amber-500/10 border-amber-500/20 text-amber-500'}`}>
            <p className="text-[10px] uppercase font-semibold tracking-wider mb-1">Remaining After (₹)</p>
            <p className="font-mono text-lg font-bold">{inr(remainingAfter)}</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 sm:px-6 py-5 flex-1 overflow-y-auto space-y-4">
          {/* FX guard: a non-INR invoice with no rate stamped (rate 1) would settle
              at 1 unit = ₹1. Block allocation and tell the user to fix the rate. */}
          {rateUnset && (
            <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-500 text-xs">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                This invoice is billed in <strong>{invoiceCurrency}</strong> but has no exchange rate set
                (treated as 1 {invoiceCurrency} = ₹1). Its ₹ balance below is the raw {invoiceCurrency} figure,
                so allocating here would mark it paid at 1:1. Set the invoice&apos;s exchange rate first, then allocate.
              </p>
            </div>
          )}
          {isForeign && !rateUnset && (
            <p className="text-[11px] text-muted-foreground">
              Allocations are in ₹ (cash received). The invoice settles at {Number(exchangeRate).toLocaleString('en-IN')} ₹/{invoiceCurrency}.
            </p>
          )}
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
                          onClick={() => setRemoveAllocId(e.thisInvoiceAllocId!)}
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
                        className="text-[11px] font-medium text-violet-400 hover:text-violet-700 dark:text-violet-300 px-2 py-1.5 rounded-lg hover:bg-violet-500/10 transition-colors whitespace-nowrap">
                        Max
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Settle-in-full preview: realized rate + FX variance (foreign, unsettled) */}
        {canSettleInFull && enteredTotal > 0.01 && (
          <div className="px-5 sm:px-6 pb-1">
            <div className="flex items-start gap-2 p-3 rounded-lg border border-violet-500/25 bg-violet-500/[0.06] text-xs">
              <Wallet className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
              <p className="text-muted-foreground">
                <span className="text-foreground font-medium">Settle in full:</span> mark {invoiceNumber} fully paid at the
                realized rate <span className="font-mono text-foreground">{realizedRate.toLocaleString('en-IN')} ₹/{invoiceCurrency}</span>
                {' '}({ccy(balanceDueNative as number, invoiceCurrency)} = {inr(enteredTotal)}).
                {fxVariance !== 0 && (marketRate ?? 0) > 0 && (
                  <> Realized FX {fxVariance < 0 ? 'loss' : 'gain'}{' '}
                    <span className={`font-mono font-semibold ${fxVariance < 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {fxVariance < 0 ? '−' : '+'}{inr(Math.abs(fxVariance))}
                    </span>{' '}
                    <span className="text-muted-foreground/70">vs ₹{(marketRate as number).toLocaleString('en-IN')}/{invoiceCurrency} market — shown for awareness, not booked as an expense.</span>
                  </>
                )}
              </p>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-t border-border bg-secondary/20">
          <p className="text-xs text-muted-foreground">
            Allocating <span className="font-mono font-semibold text-foreground">{inr(enteredTotal)}</span>
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm rounded-lg hover:bg-secondary/80 text-muted-foreground transition-colors disabled:opacity-50">Cancel</button>
            {canSettleInFull && (
              <button
                onClick={handleSettleInFull}
                disabled={saving || loading || enteredTotal <= 0.01}
                title="Mark this foreign invoice fully paid at the realized rate (₹ received ÷ amount)"
                className="px-4 py-2 text-sm font-medium rounded-lg bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
                {saving ? 'Saving…' : 'Settle in full'}
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || loading || rateUnset || enteredTotal <= 0.01 || remainingAfter < -0.01}
              title={rateUnset ? `Set the invoice's ${invoiceCurrency} exchange rate before allocating` : undefined}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-violet-600 hover:bg-violet-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5">
              {saving ? 'Saving…' : <>Allocate <ArrowRight className="w-3.5 h-3.5" /></>}
            </button>
          </div>
        </div>
      </div>
      {removeAllocId && (
        <ConfirmDialog
          title="Undo this allocation?"
          body="The payment goes back to unallocated cash in the book and this invoice's outstanding balance rises again. Nothing is refunded — only the link between the two is removed."
          confirmLabel="Undo allocation"
          danger
          onConfirm={() => { const id = removeAllocId; setRemoveAllocId(null); void handleRemove(id) }}
          onCancel={() => setRemoveAllocId(null)}
        />
      )}
    </ModalOverlay>
  )
}
