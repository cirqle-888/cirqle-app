'use client'

import { useMemo, useState } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { ModalOverlay } from '@/components/ui/modal-overlay'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { insertTransfer, updateTransfer } from '@/app/(dashboard)/dashboard/cashbook/transfer-actions'
import { buildTransferLegs, currencyOf, legDescription, transferFxDifference, validateTransfer, type RateMap } from '@/lib/cashbook/transfers'
import { todayISO } from '@/lib/utils/local-date'

interface BankAccount {
  id: string
  name: string
  type: string
  is_active: boolean
  currency?: string | null
}

interface Leg {
  id: string
  bank_account_id?: string | null
  amount?: number | null
  entry_date: string
  description?: string | null
  bank_account?: { name?: string | null } | null
}

interface Props {
  bankAccounts: BankAccount[]
  exchangeRates: { currency: string; rate_to_inr: number }[]
  /** Edit an existing transfer: both legs are rewritten together. */
  editing?: { transferRef: string; outflow: Leg | null; inflow: Leg | null } | null
  /** Start a NEW transfer from an existing one (Duplicate): accounts and amounts, dated today. */
  prefill?: { outflow: Leg | null; inflow: Leg | null } | null
  onClose: () => void
  onSaved: (outflow: any, inflow: any) => void
}

const SYMBOL: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'AED ' }
const sym = (c: string) => SYMBOL[c] ?? `${c} `

/** The note typed on a leg, or '' when it carries the automatic "Transfer to X". */
function noteOf(leg: Leg | null, otherName: string, type: 'outflow' | 'inflow'): string {
  const d = leg?.description ?? ''
  return d === legDescription(type, otherName) ? '' : d
}

export default function TransferModal({ bankAccounts, exchangeRates, editing, prefill, onClose, onSaved }: Props) {
  const source = editing ?? prefill ?? null
  const accounts = bankAccounts.filter(a => a.is_active || a.id === source?.outflow?.bank_account_id || a.id === source?.inflow?.bank_account_id)
  const rates: RateMap = useMemo(() => {
    const m: RateMap = { INR: 1 }
    for (const r of exchangeRates) if (r.currency) m[r.currency.toUpperCase()] = Number(r.rate_to_inr)
    return m
  }, [exchangeRates])

  const [fromId, setFromId]     = useState(source?.outflow?.bank_account_id ?? accounts[0]?.id ?? '')
  const [toId, setToId]         = useState(source?.inflow?.bank_account_id ?? accounts[1]?.id ?? '')
  const [amount, setAmount]     = useState(source?.outflow?.amount != null ? String(source.outflow.amount) : '')
  const [received, setReceived] = useState(source?.inflow?.amount != null ? String(source.inflow.amount) : '')
  const [date, setDate]         = useState(editing?.outflow?.entry_date ?? todayISO())
  const [desc, setDesc]         = useState(
    noteOf(source?.outflow ?? null, source?.inflow?.bank_account?.name ?? '', 'outflow'))
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')
  const [confirming, setConfirming] = useState(false)

  const from = accounts.find(a => a.id === fromId)
  const to = accounts.find(a => a.id === toId)
  const fromCur = currencyOf(from)
  const toCur = currencyOf(to)
  const crossCurrency = !!from && !!to && fromCur !== toCur

  const payload = {
    from_account_id: fromId,
    to_account_id: toId,
    amount: parseFloat(amount),
    amount_received: crossCurrency ? parseFloat(received) : null,
    entry_date: date,
    description: desc.trim(),
  }
  const errors = validateTransfer(payload, accounts, rates)
  // What the conversion cost or gained, at book rates — reported as FX.
  const fx = crossCurrency && errors.length === 0
    ? transferFxDifference(Object.values(buildTransferLegs(payload, accounts, rates)))
    : 0

  async function save() {
    setSaving(true)
    setError('')
    const res = editing
      ? await updateTransfer(editing.transferRef, payload)
      : await insertTransfer(payload)
    setSaving(false)
    setConfirming(false)
    if (!res.ok) { setError(res.error ?? 'Failed to save'); return }
    onSaved(res.data!.outflow, res.data!.inflow)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (errors.length) { setError(errors[0]); return }
    // Editing rewrites two entries — say so before doing it.
    if (editing) { setConfirming(true); return }
    void save()
  }

  const selectClass = 'w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'
  const inputClass  = 'w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30'

  const amountField = (label: string, currency: string, value: string, set: (v: string) => void) => (
    <div className="space-y-1 flex-1">
      <label className="text-xs text-muted-foreground font-medium">{label} ({currency})</label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{sym(currency)}</span>
        <input
          type="number" min="0.01" step="0.01" value={value}
          onChange={e => set(e.target.value)} placeholder="0.00"
          className={`${inputClass} ${sym(currency).length > 1 ? 'pl-12' : 'pl-7'}`} required
        />
      </div>
    </div>
  )

  return (
    <ModalOverlay onClose={onClose} sheetOnMobile>
      <div className="bg-card border border-border rounded-t-2xl sm:rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="font-semibold">{editing ? 'Edit Internal Transfer' : 'Internal Transfer'}</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">Not income or expense — moves money between your own accounts.</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
        </div>

      <form onSubmit={submit} className="px-6 py-5 space-y-4 overflow-y-auto">
        {/* From → To */}
        <div className="flex items-center gap-2">
          <div className="flex-1 space-y-1 min-w-0">
            <label className="text-xs text-muted-foreground font-medium">From Account</label>
            <select value={fromId} onChange={e => setFromId(e.target.value)} className={selectClass} required>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}{currencyOf(a) !== 'INR' ? ` (${currencyOf(a)})` : ''}</option>
              ))}
            </select>
          </div>
          <ArrowRight className="w-4 h-4 text-muted-foreground mt-5 shrink-0" />
          <div className="flex-1 space-y-1 min-w-0">
            <label className="text-xs text-muted-foreground font-medium">To Account</label>
            <select value={toId} onChange={e => setToId(e.target.value)} className={selectClass} required>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}{currencyOf(a) !== 'INR' ? ` (${currencyOf(a)})` : ''}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Amount — one, or sent + received across currencies */}
        <div className="flex gap-2">
          {amountField(crossCurrency ? 'Amount sent' : 'Amount', fromCur, amount, setAmount)}
          {crossCurrency && amountField('Amount received', toCur, received, setReceived)}
        </div>
        {crossCurrency && errors.length === 0 && Math.abs(fx) >= 0.01 && (
          <p className="text-[11px] text-muted-foreground -mt-2">
            At book rates the conversion {fx >= 0 ? 'gained' : 'cost'}{' '}
            <span className={fx >= 0 ? 'text-green-500' : 'text-red-400'}>₹{Math.abs(fx).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
            {' '}— shown as FX, never as income or expense.
          </p>
        )}

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
            {saving ? 'Saving…' : editing ? 'Save both legs' : 'Transfer'}
          </button>
        </div>
      </form>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Change both legs?"
          body={`This rewrites the outflow from ${from?.name ?? 'the From account'} and the inflow to ${to?.name ?? 'the To account'} together.`}
          confirmLabel="Save both legs"
          onConfirm={() => void save()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </ModalOverlay>
  )
}
