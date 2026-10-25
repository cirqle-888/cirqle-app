'use client'

import { useState } from 'react'
import { ArrowLeftRight, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { convertToTransfer } from '@/app/(dashboard)/dashboard/cashbook/transfer-actions'

interface Entry {
  id: string
  type: string
  entry_date: string
  description?: string | null
  amount_inr?: number | null
  category?: { name?: string | null } | null
  bank_account?: { name?: string | null } | null
}

interface Props {
  entry: Entry
  /** Opposite entries on other accounts, same date and amount (findTransferCounterparts). */
  candidates: Entry[]
  onClose: () => void
  onSaved: (ids: string[], transferRef: string) => void
}

const inr = (n?: number | null) => `₹${Number(n ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`

/**
 * Convert to transfer: an expense on one account and an income on another,
 * typed in separately before the Transfer button existed, become one
 * internal transfer — and stop counting as income AND expense.
 */
export default function ConvertTransferModal({ entry, candidates, onClose, onSaved }: Props) {
  const [pick, setPick] = useState(candidates.length === 1 ? candidates[0].id : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const other = candidates.find(c => c.id === pick)
  const outflow = entry.type === 'outflow' ? entry : other
  const inflow = entry.type === 'inflow' ? entry : other

  async function submit() {
    if (!pick) { setError('Pick the matching entry'); return }
    setSaving(true)
    setError('')
    const res = await convertToTransfer(entry.id, pick)
    setSaving(false)
    if (!res.ok) { setError(res.error ?? 'Failed to convert'); return }
    onSaved(res.data!.ids, res.data!.transferRef)
  }

  const line = (e: Entry) => (
    <div className="min-w-0">
      <div className="text-sm font-medium truncate">{e.description || e.category?.name || 'Entry'}</div>
      <div className="text-xs text-muted-foreground">
        {e.type === 'inflow' ? 'Income' : 'Expense'}{e.category?.name ? ` · ${e.category.name}` : ''} · {e.bank_account?.name ?? '—'}
      </div>
    </div>
  )

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="font-semibold flex items-center gap-2"><ArrowLeftRight className="w-4 h-4 text-purple-400" />Convert to transfer</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <p className="text-xs text-muted-foreground">
            Pairs this entry with its other side on {entry.entry_date} ({inr(entry.amount_inr)}) into one internal
            transfer. Both stop counting as income or expense; their descriptions and bank matches are kept, their
            category and client tag are cleared.
          </p>

          <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5">{line(entry)}</div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium">{candidates.length > 1 ? 'Pick the other side' : 'Other side'}</p>
            {candidates.map(c => (
              <label key={c.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer ${pick === c.id ? 'border-purple-500/50 bg-purple-500/5' : 'border-border hover:bg-secondary/40'}`}>
                <input type="radio" name="counterpart" checked={pick === c.id} onChange={() => setPick(c.id)} />
                {line(c)}
              </label>
            ))}
          </div>

          {outflow && inflow && (
            <p className="text-sm">
              Becomes <span className="font-medium">Transfer: {outflow.bank_account?.name ?? '—'} to {inflow.bank_account?.name ?? '—'}</span>
            </p>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 bg-secondary text-sm font-medium py-2.5 rounded-lg hover:bg-secondary/80">Cancel</button>
            <button type="button" onClick={() => void submit()} disabled={saving || !pick} className="flex-1 gradient-bg text-white text-sm font-medium py-2.5 rounded-lg hover:opacity-90 disabled:opacity-50">
              {saving ? 'Converting…' : 'Convert to transfer'}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
