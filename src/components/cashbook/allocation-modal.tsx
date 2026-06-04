'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Plus, Trash2, CheckCircle2, ShieldAlert, Sparkles, TrendingUp, TrendingDown } from 'lucide-react'
import Combobox from '@/components/ui/combobox'

interface Allocation {
  id: string
  invoice_id: string
  allocated_amount: number
  invoice?: {
    invoice_number: string
    status: string
    due_date?: string
    total_amount: number
    paid_amount: number
    total_amount_inr?: number
    paid_amount_inr?: number
    currency?: string
    client?: { name: string }
  }
}

// A reviewable, not-yet-saved auto-allocation line.
interface ProposedRow {
  invoice_id: string
  invoice_number: string
  client_name: string
  outstanding: number       // ₹ outstanding (the cap), for reference
  amount: number            // ₹ proposed to allocate (editable before saving)
  existingId?: string       // existing allocation to add onto, if any
  existingAmount?: number
}

interface Props {
  entryId: string
  entryDate?: string          // YYYY-MM-DD - for date-constrained FIFO
  entryClientId?: string      // client_id on the payment entry - restricts invoices to same client
  amountInr: number
  // FX display props — used for the realised gain/loss indicator (no extra entries created)
  entryCurrency?: string      // e.g. 'AED' — if INR, no FX panel shown
  entryForeignAmount?: number // the original foreign-currency amount
  entryBookRate?: number      // rate_to_inr from exchange_rates at time of entry
  dueInvoices: any[]
  onClose: () => void
  onUpdate: () => void // trigger refresh in parent
}

export default function AllocationModal({ entryId, entryDate, entryClientId, amountInr, entryCurrency, entryForeignAmount, entryBookRate, dueInvoices, onClose, onUpdate }: Props) {
  const [allocations, setAllocations] = useState<Allocation[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const supabase = createClient()

  useEffect(() => {
    fetchAllocations()
  }, [])

  async function fetchAllocations() {
    setLoading(true)
    const { data } = await supabase
      .from('cashbook_invoice_allocations')
      .select(`
        id, 
        invoice_id, 
        allocated_amount,
        invoice:invoices(invoice_number, status, due_date, total_amount, paid_amount, total_amount_inr, paid_amount_inr, currency, client:clients(name))
      `)
      .eq('cashbook_entry_id', entryId)
      .is('deleted_at', null)
    
    if (data) {
      setAllocations(data as unknown as Allocation[])
    }
    setLoading(false)
  }

  const totalAllocated = allocations.reduce((sum, a) => sum + (Number(a.allocated_amount) || 0), 0)
  const unallocated = amountInr - totalAllocated

  // ── Realised FX gain/loss (display only) ──────────────────────────────────
  // FX gain/loss = actual INR received − (foreign amount × book rate at entry).
  // No extra cashbook entries are created; this is purely informational.
  const isForeignEntry  = entryCurrency && entryCurrency !== 'INR' && (entryForeignAmount ?? 0) > 0 && (entryBookRate ?? 0) > 0
  const fxExpectedInr   = isForeignEntry ? Math.round(((entryForeignAmount ?? 0) * (entryBookRate ?? 0)) * 100) / 100 : 0
  const fxDiff          = isForeignEntry ? Math.round((amountInr - fxExpectedInr) * 100) / 100 : 0
  const fxDirection     = Math.abs(fxDiff) > 0.005 ? (fxDiff > 0 ? 'gain' : 'loss') : 'none'

  // ── Entity-aware filtering ───────────────────────────────────────────────────
  // 1. Mutual exclusion: hide invoices already paid via "Record Payment".
  // 2. Same client: if the payment entry has a client_id, show ONLY that client's
  //    invoices. This prevents cross-client allocation (the core bug being fixed).
  //
  // NOTE: the date guard (issue_date ≤ payment date) applies ONLY to auto-allocate,
  // not to the manual dropdown. A user consciously picking a future invoice is a
  // valid advance-payment scenario (e.g. client pays two months at once).
  const eligibleInvoices = dueInvoices.filter(inv => {
    if ((inv.payments || []).length > 0) return false          // mutual exclusion
    if (entryClientId && inv.client_id !== entryClientId) return false  // same client
    return true
  })
  // Strict subset used for auto-allocate only (oldest first, no future invoices).
  const autoEligibleInvoices = eligibleInvoices.filter(inv =>
    !entryDate || !inv.issue_date || inv.issue_date <= entryDate
  )
  const hiddenForPayments = dueInvoices.filter(inv => (inv.payments || []).length > 0).length
  const hiddenCrossClient = entryClientId
    ? dueInvoices.filter(inv => !(inv.payments || []).length && inv.client_id !== entryClientId).length
    : 0
  const hiddenFutureFromAuto = eligibleInvoices.length - autoEligibleInvoices.length

  const [newAllocInvoice, setNewAllocInvoice] = useState('')
  const [newAllocAmount, setNewAllocAmount] = useState('')

  // Auto-allocate proposes a distribution into `proposed` for review; nothing is
  // written until the user confirms (they can edit amounts or drop rows first).
  const [proposed, setProposed] = useState<ProposedRow[] | null>(null)

  async function handleAdd() {
    if (!newAllocInvoice || !newAllocAmount) return
    const amt = parseFloat(newAllocAmount)
    if (isNaN(amt) || amt <= 0) {
      setError('Amount must be greater than 0')
      return
    }
    if (amt > unallocated + 0.01) { // slight floating point tolerance
      setError('Cannot over-allocate payment amount')
      return
    }

    setSaving(true)
    setError('')
    
    // Check if we are already allocating to this invoice
    const existing = allocations.find(a => a.invoice_id === newAllocInvoice)
    if (existing) {
       // Update existing
       const { error: updErr } = await supabase
         .from('cashbook_invoice_allocations')
         .update({ allocated_amount: Number(existing.allocated_amount) + amt })
         .eq('id', existing.id)
       if (updErr) setError(updErr.message)
    } else {
       // Insert new
       const { error: insErr } = await supabase
         .from('cashbook_invoice_allocations')
         .insert({
           cashbook_entry_id: entryId,
           invoice_id: newAllocInvoice,
           allocated_amount: amt
         })
       if (insErr) setError(insErr.message)
    }
    
    if (!error) {
      setNewAllocInvoice('')
      setNewAllocAmount('')
      await fetchAllocations()
      onUpdate()
    }
    setSaving(false)
  }

  function round2(n: number) { return Math.round(n * 100) / 100 }

  // Invoice outstanding in ₹ (INR base) - the currency the payment and its
  // allocations are denominated in. allocated_amount is always ₹, so we compare
  // against the invoice's INR balance (total_amount_inr − paid_amount_inr), NOT
  // its foreign-currency balance. Falls back to raw amounts for INR/pre-FX rows.
  function outstandingInr(inv: any): number {
    const total = inv.total_amount_inr ?? inv.total_amount ?? 0
    const paid = inv.paid_amount_inr ?? inv.paid_amount ?? 0
    return round2(total - paid)
  }

  // Build a proposed oldest-issue-date-first distribution for REVIEW. Nothing is
  // written - the rows go into `proposed` so the user can check/edit/drop each
  // invoice before saving. Uses autoEligibleInvoices (date-guarded, same client only).
  function previewAutoAllocate() {
    if (unallocated <= 0.01) return
    setError('')
    let remaining = unallocated
    const sorted = [...autoEligibleInvoices].sort((a, b) => (a.issue_date || '').localeCompare(b.issue_date || ''))
    const rows: ProposedRow[] = []

    for (const inv of sorted) {
      if (remaining <= 0.01) break
      const existing = allocations.find(a => a.invoice_id === inv.id)
      const alreadyForThis = existing ? Number(existing.allocated_amount) : 0
      const outstanding = round2(outstandingInr(inv) - alreadyForThis)
      if (outstanding <= 0.01) continue
      const give = round2(Math.min(remaining, outstanding))
      if (give <= 0.01) continue
      rows.push({
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        client_name: inv.client?.name || '',
        outstanding,
        amount: give,
        existingId: existing?.id,
        existingAmount: alreadyForThis,
      })
      remaining = round2(remaining - give)
    }

    if (rows.length === 0) {
      setError('No open invoices available to auto-allocate.')
      return
    }
    setProposed(rows)
  }

  function updateProposedAmount(idx: number, value: number) {
    setProposed(prev => (prev ? prev.map((r, i) => (i === idx ? { ...r, amount: value } : r)) : prev))
  }
  function removeProposed(idx: number) {
    setProposed(prev => {
      const next = (prev || []).filter((_, i) => i !== idx)
      return next.length ? next : null
    })
  }

  // Commit the reviewed proposal: add onto existing allocations, insert new ones.
  async function confirmProposed() {
    if (!proposed) return
    const rows = proposed.filter(r => (r.amount || 0) > 0.01)
    if (rows.length === 0) { setProposed(null); return }
    const sum = round2(rows.reduce((s, r) => s + r.amount, 0))
    if (sum > unallocated + 0.01) { setError('Proposed total exceeds the unallocated balance.'); return }

    setSaving(true)
    setError('')
    try {
      for (const r of rows.filter(r => r.existingId)) {
        const { error: e } = await supabase
          .from('cashbook_invoice_allocations')
          .update({ allocated_amount: round2((r.existingAmount || 0) + r.amount) })
          .eq('id', r.existingId!)
        if (e) { setError(e.message); return }
      }
      const toInsert = rows
        .filter(r => !r.existingId)
        .map(r => ({ cashbook_entry_id: entryId, invoice_id: r.invoice_id, allocated_amount: round2(r.amount) }))
      if (toInsert.length) {
        const { error: e } = await supabase.from('cashbook_invoice_allocations').insert(toInsert)
        if (e) { setError(e.message); return }
      }
      setProposed(null)
      await fetchAllocations()
      onUpdate()
    } catch (e: any) {
      setError(e?.message || 'Failed to save allocations')
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(allocId: string) {
    if (!confirm('Remove this allocation?')) return
    setSaving(true)
    const { error } = await supabase
      .from('cashbook_invoice_allocations')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', allocId)
    
    if (!error) {
      await fetchAllocations()
      onUpdate()
    } else {
      setError(error.message)
    }
    setSaving(false)
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-secondary/30">
          <div>
            <h2 className="font-semibold">Manage Invoice Allocations</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Distribute this payment across invoices</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-6 flex-1 overflow-y-auto space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-3 gap-4">
             <div className="bg-secondary/50 border border-border rounded-lg p-3 text-center">
               <p className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground mb-1">Total Payment</p>
               <p className="font-mono text-lg font-bold">₹{amountInr.toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
             </div>
             <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-center">
               <p className="text-[10px] uppercase font-semibold tracking-wider text-green-500/80 mb-1">Allocated</p>
               <p className="font-mono text-lg font-bold text-green-500">₹{totalAllocated.toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
             </div>
             <div className={`border rounded-lg p-3 text-center ${unallocated < 0 ? 'bg-red-500/10 border-red-500/20 text-red-500' : unallocated === 0 ? 'bg-secondary/50 border-border text-muted-foreground' : 'bg-amber-500/10 border-amber-500/20 text-amber-500'}`}>
               <p className="text-[10px] uppercase font-semibold tracking-wider mb-1">Unallocated</p>
               <p className="font-mono text-lg font-bold">₹{unallocated.toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
             </div>
          </div>

          {/* ── Realised FX Gain / Loss (display only, no entries created) ────── */}
          {fxDirection !== 'none' && (
            <div className={`flex items-center justify-between rounded-lg border px-4 py-3 ${fxDirection === 'gain' ? 'border-green-500/25 bg-green-500/5' : 'border-red-500/25 bg-red-500/5'}`}>
              <div className="flex items-center gap-2.5">
                {fxDirection === 'gain'
                  ? <TrendingUp  className="w-4 h-4 text-green-400 shrink-0" />
                  : <TrendingDown className="w-4 h-4 text-red-400   shrink-0" />}
                <div>
                  <p className={`text-xs font-semibold ${fxDirection === 'gain' ? 'text-green-400' : 'text-red-400'}`}>
                    Realised FX {fxDirection === 'gain' ? 'Gain' : 'Loss'} — display only
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {entryForeignAmount} {entryCurrency} × ₹{entryBookRate}/{ entryCurrency} (book rate) = ₹{fxExpectedInr.toLocaleString('en-IN')} &nbsp;·&nbsp; Actual ₹ received = ₹{amountInr.toLocaleString('en-IN')}
                  </p>
                </div>
              </div>
              <span className={`font-mono text-sm font-bold shrink-0 ${fxDirection === 'gain' ? 'text-green-400' : 'text-red-400'}`}>
                {fxDirection === 'gain' ? '+' : '-'}₹{Math.abs(fxDiff).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-sm">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}

          {/* Existing Allocations */}
          <div>
            <h3 className="text-sm font-medium mb-3">Current Allocations</h3>
            {loading ? (
              <p className="text-sm text-muted-foreground animate-pulse">Loading...</p>
            ) : allocations.length === 0 ? (
              <div className="text-center py-6 bg-secondary/30 rounded-lg border border-border border-dashed">
                <p className="text-sm text-muted-foreground">No invoices linked yet.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {allocations.map(a => (
                  <div key={a.id} className="flex items-center justify-between p-3 bg-secondary/30 border border-border rounded-lg group">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{a.invoice?.invoice_number}</span>
                        {a.invoice?.status === 'paid' && <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{a.invoice?.client?.name}</p>
                    </div>
                    <div className="flex items-center gap-4">
                      <p className="font-mono text-sm font-semibold">₹{Number(a.allocated_amount).toLocaleString('en-IN', {minimumFractionDigits:2})}</p>
                      <button onClick={() => handleRemove(a.id)} disabled={saving} className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add New Allocation */}
          {unallocated > 0.01 && (
            <div className="border-t border-border pt-5 mt-5">
              <div className="flex items-center justify-between mb-3 gap-3">
                <div>
                  <h3 className="text-sm font-medium">Allocate Balance</h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Auto-fills oldest invoices first, or pick manually below.</p>
                  {hiddenForPayments > 0 && (
                    <p className="text-[11px] text-amber-500/90 mt-0.5">
                      {hiddenForPayments} invoice{hiddenForPayments > 1 ? 's' : ''} hidden — already paid via Record Payment.
                    </p>
                  )}
                  {hiddenCrossClient > 0 && (
                    <p className="text-[11px] text-blue-400/90 mt-0.5">
                      {hiddenCrossClient} invoice{hiddenCrossClient > 1 ? 's' : ''} from other clients hidden — payments can only allocate to the same client.
                    </p>
                  )}
                  {hiddenFutureFromAuto > 0 && (
                    <p className="text-[11px] text-violet-400/90 mt-0.5">
                      {hiddenFutureFromAuto} future invoice{hiddenFutureFromAuto > 1 ? 's' : ''} excluded from auto-allocate — pick manually below to allocate advance payments.
                    </p>
                  )}
                  {!entryClientId && (
                    <p className="text-[11px] text-amber-400/90 mt-0.5">
                      No client tagged on this payment — tag a client on the entry to enable per-client filtering.
                    </p>
                  )}
                </div>
                <button
                  onClick={previewAutoAllocate}
                  disabled={saving || !!proposed}
                  className="shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                  title="Preview an oldest-first split to review before saving"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Auto-allocate
                </button>
              </div>

              {/* Proposed auto-allocation - review & edit before anything is saved */}
              {proposed && (() => {
                const proposedTotal = round2(proposed.reduce((s, r) => s + (Number(r.amount) || 0), 0))
                const over = proposedTotal > unallocated + 0.01
                return (
                  <div className="mb-4 border border-primary/30 bg-primary/5 rounded-lg p-3 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium">Review before saving - {proposed.length} invoice{proposed.length > 1 ? 's' : ''}</p>
                      <button onClick={() => setProposed(null)} className="text-[11px] text-muted-foreground hover:text-foreground">Discard</button>
                    </div>
                    {proposed.map((r, i) => (
                      <div key={r.invoice_id} className="flex items-center gap-2.5">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{r.invoice_number}</div>
                          <div className="text-[11px] text-muted-foreground truncate">{r.client_name} · ₹{r.outstanding.toLocaleString('en-IN')} outstanding</div>
                        </div>
                        <div className="flex items-center gap-1 text-sm">
                          <span className="text-muted-foreground">₹</span>
                          <input
                            type="number" step="0.01" min="0"
                            value={r.amount}
                            onChange={e => updateProposedAmount(i, parseFloat(e.target.value) || 0)}
                            className="w-24 bg-secondary border border-border rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-primary/50"
                          />
                        </div>
                        <button onClick={() => removeProposed(i)} className="text-muted-foreground hover:text-destructive transition-colors" title="Remove from proposal">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center justify-between pt-1.5 border-t border-border/50 text-xs">
                      <span className="text-muted-foreground">Proposed total</span>
                      <span className={`font-mono font-semibold ${over ? 'text-destructive' : ''}`}>₹{proposedTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                    {over && <p className="text-[11px] text-destructive">Exceeds the unallocated balance by ₹{(proposedTotal - unallocated).toFixed(2)} - reduce an amount.</p>}
                    <button
                      onClick={confirmProposed}
                      disabled={saving || proposedTotal <= 0.01 || over}
                      className="w-full flex items-center justify-center gap-1.5 gradient-bg text-white text-sm font-medium py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      {saving ? 'Saving…' : `Save ${proposed.length} allocation${proposed.length > 1 ? 's' : ''}`}
                    </button>
                  </div>
                )
              })()}

              <div className="flex flex-col sm:flex-row gap-3 items-end">
                <div className="flex-1 w-full space-y-1.5">
                  <label className="text-xs text-muted-foreground">Select Invoice</label>
                  <Combobox
                    options={eligibleInvoices.map(inv => {
                      const outInr = outstandingInr(inv)
                      // For foreign invoices, also show the native-currency balance for context.
                      const foreign = inv.currency && inv.currency !== 'INR'
                        ? ` · ${inv.currency} ${round2((inv.total_amount || 0) - (inv.paid_amount || 0)).toLocaleString()}`
                        : ''
                      const isFuture = entryDate && inv.issue_date && inv.issue_date > entryDate
                      return {
                        id: inv.id,
                        label: `${inv.invoice_number}${isFuture ? ' ↑' : ''} - ${inv.client?.name}`,
                        sub: `₹${outInr.toLocaleString('en-IN')} outstanding${foreign}`,
                      }
                    })}
                    value={newAllocInvoice}
                    onChange={id => {
                      setNewAllocInvoice(id)
                      const inv = eligibleInvoices.find(i => i.id === id)
                      if (inv) {
                        // Suggest the min of (unallocated ₹ balance, invoice ₹ outstanding).
                        const suggest = Math.min(unallocated, outstandingInr(inv))
                        setNewAllocAmount(suggest > 0 ? suggest.toString() : unallocated.toString())
                      }
                    }}
                    placeholder="Search invoice..."
                  />
                </div>
                <div className="w-full sm:w-32 space-y-1.5">
                  <label className="text-xs text-muted-foreground">Amount (₹)</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    max={unallocated}
                    value={newAllocAmount}
                    onChange={e => setNewAllocAmount(e.target.value)}
                    className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <button 
                  onClick={handleAdd}
                  disabled={saving || !newAllocInvoice || !newAllocAmount}
                  className="w-full sm:w-auto flex items-center justify-center gap-1.5 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
