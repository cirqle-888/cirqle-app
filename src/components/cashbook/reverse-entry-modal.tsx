'use client'

import { useState } from 'react'
import { Undo2, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { reverseCashbookEntry } from '@/app/(dashboard)/dashboard/cashbook/reversal-actions'
import { todayISO } from '@/lib/utils/local-date'

interface Entry {
  id: string
  type: string
  entry_date: string
  description?: string | null
  amount?: number | null
  currency?: string | null
  amount_inr?: number | null
  bank_account?: { name?: string | null } | null
  allocations?: { deleted_at?: string | null; invoice?: { invoice_number?: string | null } | null }[]
  payroll_allocations?: { deleted_at?: string | null; payroll?: { employee?: { cqid?: string | null } | null } | null }[]
}

interface Props {
  entry: Entry
  categoryName: string | null
  onClose: () => void
  onSaved: (reversal: any) => void
}

/**
 * Return / Reverse: the bank handed this money back (a bounced NEFT, a
 * refund). Records the opposite entry on the same account and category, and
 * releases what the original paid for.
 */
export default function ReverseEntryModal({ entry, categoryName, onClose, onSaved }: Props) {
  const [date, setDate] = useState(todayISO() < entry.entry_date ? entry.entry_date : todayISO())
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const invoices = (entry.allocations ?? []).filter(a => !a.deleted_at)
  const payslips = (entry.payroll_allocations ?? []).filter(a => !a.deleted_at)
  const isIn = entry.type === 'inflow'
  const amount = `${entry.currency && entry.currency !== 'INR' ? `${entry.currency} ` : '₹'}${Number(entry.amount ?? entry.amount_inr ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const res = await reverseCashbookEntry(entry.id, { entry_date: date, note: note.trim() })
    setSaving(false)
    if (!res.ok) { setError(res.error ?? 'Failed to record the return'); return }
    onSaved(res.data!.reversal)
  }

  const inputClass = 'w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="font-semibold flex items-center gap-2"><Undo2 className="w-4 h-4 text-orange-500" />Return / Reverse</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <form onSubmit={submit} className="px-6 py-5 space-y-4 overflow-y-auto">
          <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5 text-sm">
            <div className="font-medium">{entry.description || categoryName || 'Entry'}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {isIn ? 'Received' : 'Paid'} {amount} · {entry.entry_date}{entry.bank_account?.name ? ` · ${entry.bank_account.name}` : ''}
            </div>
          </div>

          <div className="text-xs text-muted-foreground space-y-1.5">
            <p>
              Records {isIn ? 'an outflow' : 'an inflow'} of {amount} on the same account
              {categoryName ? <> in <span className="text-foreground">{categoryName}</span></> : null}, linked to this entry.
              The two net to zero — the return is not {isIn ? 'an expense' : 'new income'}.
            </p>
            {payslips.length > 0 && (
              <p className="text-foreground">
                The payslip{payslips.length > 1 ? 's' : ''} it paid
                {payslips.map(p => p.payroll?.employee?.cqid).filter(Boolean).length ? ` (${payslips.map(p => p.payroll?.employee?.cqid).filter(Boolean).join(', ')})` : ''}
                {' '}go{payslips.length > 1 ? '' : 'es'} back to unpaid.
              </p>
            )}
            {invoices.length > 0 && (
              <p className="text-foreground">
                {invoices.map(a => a.invoice?.invoice_number).filter(Boolean).join(', ') || 'The invoice'} go{invoices.length > 1 ? '' : 'es'} back to unpaid by this amount.
              </p>
            )}
            <p>Deleting the return later undoes all of this.</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Date returned</label>
            <input type="date" value={date} min={entry.entry_date} onChange={e => setDate(e.target.value)} className={inputClass} required />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Reason (optional)</label>
            <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Beneficiary account closed — NEFT returned" className={inputClass} />
          </div>

          {error && <p className="text-destructive text-xs">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 bg-orange-600 text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
              {saving ? 'Recording…' : 'Record return'}
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  )
}
