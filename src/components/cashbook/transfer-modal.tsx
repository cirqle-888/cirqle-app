'use client'

import { useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { insertTransfer } from '@/app/(dashboard)/dashboard/cashbook/actions'

interface BankAccount {
  id: string
  name: string
  type: string
  is_active: boolean
}

interface Props {
  bankAccounts: BankAccount[]
  onClose: () => void
  onSaved: (outflow: any, inflow: any) => void
}

export default function TransferModal({ bankAccounts, onClose, onSaved }: Props) {
  const activeAccounts = bankAccounts.filter(a => a.is_active)
  const [fromId, setFromId]   = useState(activeAccounts[0]?.id ?? '')
  const [toId, setToId]       = useState(activeAccounts[1]?.id ?? '')
  const [amount, setAmount]   = useState('')
  const [date, setDate]       = useState(new Date().toISOString().slice(0, 10))
  const [desc, setDesc]       = useState('')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!fromId || !toId) { setError('Select both accounts'); return }
    if (fromId === toId)  { setError('From and To must be different accounts'); return }
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) { setError('Enter a valid amount'); return }
    setSaving(true)
    setError('')
    const res = await insertTransfer({ from_account_id: fromId, to_account_id: toId, amount: amt, entry_date: date, description: desc.trim() })
    setSaving(false)
    if (!res.ok) { setError(res.error ?? 'Failed to save'); return }
    onSaved(res.data!.outflow, res.data!.inflow)
  }

  const selectClass = 'w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'
  const inputClass  = 'w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="font-semibold">Internal Transfer</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

      <form onSubmit={submit} className="px-6 py-5 space-y-4 overflow-y-auto">
        {/* From → To */}
        <div className="flex items-center gap-2">
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground font-medium">From Account</label>
            <select value={fromId} onChange={e => setFromId(e.target.value)} className={selectClass} required>
              {activeAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground mt-5 shrink-0" />
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground font-medium">To Account</label>
            <select value={toId} onChange={e => setToId(e.target.value)} className={selectClass} required>
              {activeAccounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Amount */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground font-medium">Amount (₹)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">₹</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className={`${inputClass} pl-7`}
              required
            />
          </div>
        </div>

        {/* Date */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground font-medium">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className={inputClass} required />
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground font-medium">Notes (optional)</label>
          <input type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Cash withdrawal from Jupiter" className={inputClass} />
        </div>

        {error && <p className="text-destructive text-xs">{error}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
          <button type="submit" disabled={saving} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
            {saving ? 'Transferring…' : 'Transfer'}
          </button>
        </div>
      </form>
      </div>
    </ModalOverlay>
  )
}
