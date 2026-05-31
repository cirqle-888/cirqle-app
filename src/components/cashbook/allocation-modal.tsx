'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { X, Plus, Trash2, CheckCircle2, ShieldAlert, Sparkles } from 'lucide-react'
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
    client?: { name: string }
  }
}

interface Props {
  entryId: string
  amountInr: number
  dueInvoices: any[]
  onClose: () => void
  onUpdate: () => void // trigger refresh in parent
}

export default function AllocationModal({ entryId, amountInr, dueInvoices, onClose, onUpdate }: Props) {
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
        invoice:invoices(invoice_number, status, due_date, total_amount, paid_amount, client:clients(name))
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

  const [newAllocInvoice, setNewAllocInvoice] = useState('')
  const [newAllocAmount, setNewAllocAmount] = useState('')

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

  // One-click distribution: walk open invoices oldest-due-date first and fill
  // each to its outstanding balance until the unallocated payment runs out.
  async function handleAutoAllocate() {
    if (unallocated <= 0.01) return
    setSaving(true)
    setError('')
    try {
      let remaining = unallocated
      const sorted = [...dueInvoices].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))
      const toInsert: { cashbook_entry_id: string; invoice_id: string; allocated_amount: number }[] = []
      const toUpdate: { id: string; allocated_amount: number }[] = []

      for (const inv of sorted) {
        if (remaining <= 0.01) break
        const existing = allocations.find(a => a.invoice_id === inv.id)
        const alreadyForThis = existing ? Number(existing.allocated_amount) : 0
        const outstanding = round2((inv.total_amount - (inv.paid_amount || 0)) - alreadyForThis)
        if (outstanding <= 0.01) continue
        const give = round2(Math.min(remaining, outstanding))
        if (give <= 0.01) continue
        if (existing) {
          toUpdate.push({ id: existing.id, allocated_amount: round2(alreadyForThis + give) })
        } else {
          toInsert.push({ cashbook_entry_id: entryId, invoice_id: inv.id, allocated_amount: give })
        }
        remaining = round2(remaining - give)
      }

      if (toInsert.length === 0 && toUpdate.length === 0) {
        setError('No open invoices available to auto-allocate.')
        return
      }

      for (const u of toUpdate) {
        const { error: e } = await supabase
          .from('cashbook_invoice_allocations')
          .update({ allocated_amount: u.allocated_amount })
          .eq('id', u.id)
        if (e) { setError(e.message); return }
      }
      if (toInsert.length) {
        const { error: e } = await supabase.from('cashbook_invoice_allocations').insert(toInsert)
        if (e) { setError(e.message); return }
      }

      await fetchAllocations()
      onUpdate()
    } catch (e: any) {
      setError(e?.message || 'Auto-allocation failed')
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
                </div>
                <button
                  onClick={handleAutoAllocate}
                  disabled={saving}
                  className="shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg gradient-bg text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                  title="Distribute the remaining balance across open invoices, oldest first"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Auto-allocate
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-3 items-end">
                <div className="flex-1 w-full space-y-1.5">
                  <label className="text-xs text-muted-foreground">Select Invoice</label>
                  <Combobox
                    options={dueInvoices.map(inv => {
                      const out = inv.total_amount - (inv.paid_amount || 0)
                      return {
                        id: inv.id,
                        label: `${inv.invoice_number} — ${inv.client?.name}`,
                        sub: `₹${out.toLocaleString('en-IN')} outstanding`,
                      }
                    })}
                    value={newAllocInvoice}
                    onChange={id => {
                      setNewAllocInvoice(id)
                      const inv = dueInvoices.find(i => i.id === id)
                      if (inv) {
                        const out = inv.total_amount - (inv.paid_amount || 0)
                        // Suggest allocating the min of (unallocated balance, outstanding invoice balance)
                        const suggest = Math.min(unallocated, out)
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
