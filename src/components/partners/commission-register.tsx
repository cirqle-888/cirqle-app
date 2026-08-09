'use client'

/**
 * Commission register — what has actually been PAID to a partner.
 *
 * Deliberately stores only payouts. "Pending" is derived, never stored: earned
 * (at whatever rate the planner is currently showing) minus paid. That's the
 * only honest way to do it while there are no agreements — the rate can differ
 * between payouts, so a stored balance would go stale the moment it moves.
 *
 * Each payout snapshots the percent/basis it was computed under, so history
 * still reads correctly after the rate changes.
 */

import { useState } from 'react'
import { Wallet, Plus, Trash2, X } from 'lucide-react'
import AppSelect from '@/components/ui/app-select'
import { recordCommissionPayment, deleteCommissionPayment } from '@/app/(dashboard)/dashboard/partners/actions'
import type { CommissionPayment } from '@/lib/partners/queries'
import { formatDate } from '@/lib/utils/format-date'

const fmt = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtDate = formatDate

const BASIS_LABEL: Record<string, string> = {
  net_collected: 'net collected',
  net_invoiced:  'net invoiced',
  profit:        'profit',
}

export default function CommissionRegister({
  partnerId, payments, earnedNow, plannerPercent, plannerBasis, canEdit,
}: {
  partnerId: string
  payments: CommissionPayment[]
  /** Commission earned on money already collected, at the planner's current rate. */
  earnedNow: number
  plannerPercent: number
  plannerBasis: 'net_collected' | 'net_invoiced' | 'profit'
  canEdit: boolean
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [method, setMethod] = useState('bank_transfer')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const paid = payments.reduce((s, p) => s + Number(p.amount_inr || 0), 0)
  const pending = earnedNow - paid

  async function submit() {
    const amt = parseFloat(amount)
    if (!(amt > 0)) { setMsg('Enter an amount greater than zero.'); return }
    setBusy(true)
    const res = await recordCommissionPayment({
      partnerId,
      amountInr: amt,
      paidOn,
      method,
      reference: reference || null,
      percent: plannerPercent,
      basis: plannerBasis,
      periodFrom: null,
      periodTo: null,
      notes: notes || null,
    })
    setBusy(false)
    if (!res.ok) { setMsg(res.error || 'Could not record the payment.'); return }
    window.location.reload()
  }

  async function remove(id: string) {
    const res = await deleteCommissionPayment(id, partnerId)
    if (!res.ok) { setMsg(res.error || 'Could not remove the payment.'); return }
    window.location.reload()
  }

  return (
    <div className="bg-secondary border border-border rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Wallet className="w-4 h-4 text-muted-foreground" /> Commission Register
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            What has actually been paid. The balance is measured against the planner&apos;s current rate.
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => { setOpen(o => !o); setMsg(null) }}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg gradient-bg text-white hover:opacity-90"
          >
            {open ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {open ? 'Cancel' : 'Record payment'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4">
        <Tile label="Earned so far" value={fmt(earnedNow)} hint={`At ${plannerPercent}% of ${BASIS_LABEL[plannerBasis]}`} />
        <Tile label="Paid" value={fmt(paid)} hint={`${payments.length} payout${payments.length === 1 ? '' : 's'}`} muted />
        <Tile
          label={pending < 0 ? 'Overpaid' : 'Pending'}
          value={fmt(Math.abs(pending))}
          hint={pending < 0 ? 'Paid more than earned at this rate' : 'Still owed at this rate'}
          tint={pending < 0 ? 'text-red-500' : pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}
        />
      </div>

      {open && canEdit && (
        <div className="rounded-lg border border-border bg-background/60 p-3 mb-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Amount (₹)</label>
              <input
                type="number" min="0" step="0.01" value={amount} autoFocus
                onChange={e => setAmount(e.target.value)}
                placeholder={pending > 0 ? String(Math.round(pending)) : ''}
                className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Paid on</label>
              <input
                type="date" value={paidOn}
                onChange={e => setPaidOn(e.target.value)}
                className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Method</label>
              <AppSelect value={method} onChange={e => setMethod(e.target.value)}>
                <option value="bank_transfer">Bank transfer</option>
                <option value="upi">UPI</option>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
                <option value="adjustment">Adjustment</option>
                <option value="other">Other</option>
              </AppSelect>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted-foreground mb-1">Reference</label>
              <input
                type="text" value={reference} placeholder="UTR / ref"
                onChange={e => setReference(e.target.value)}
                className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>
          <input
            type="text" value={notes} placeholder="Note (optional) — e.g. what period this covers"
            onChange={e => setNotes(e.target.value)}
            className="w-full mt-2.5 text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="flex items-center gap-2 mt-2.5">
            <button
              onClick={submit}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg gradient-bg text-white disabled:opacity-50"
            >
              <Wallet className="w-3.5 h-3.5" /> {busy ? 'Saving…' : 'Record payment'}
            </button>
            <p className="text-[10px] text-muted-foreground">
              Stamped with the planner&apos;s current {plannerPercent}% / {BASIS_LABEL[plannerBasis]} so it still reads correctly after the rate changes.
            </p>
          </div>
        </div>
      )}

      {payments.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No commission paid yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="pb-2 font-medium">Paid on</th>
                <th className="pb-2 font-medium text-right">Amount</th>
                <th className="pb-2 font-medium">Method</th>
                <th className="pb-2 font-medium">Reference</th>
                <th className="pb-2 font-medium">Rate used</th>
                <th className="pb-2 font-medium">Note</th>
                {canEdit && <th className="pb-2"></th>}
              </tr>
            </thead>
            <tbody>
              {payments.map(p => (
                <tr key={p.id} className="border-b border-border/50 last:border-0">
                  <td className="py-2.5 text-foreground whitespace-nowrap">{fmtDate(p.paid_on)}</td>
                  <td className="py-2.5 text-right text-foreground font-medium tabular-nums">{fmt(Number(p.amount_inr))}</td>
                  <td className="py-2.5 text-muted-foreground capitalize">{(p.method || '—').replace('_', ' ')}</td>
                  <td className="py-2.5 text-muted-foreground">{p.reference || '—'}</td>
                  <td className="py-2.5 text-muted-foreground text-xs">
                    {p.percent != null ? `${p.percent}%${p.basis ? ` · ${BASIS_LABEL[p.basis] ?? p.basis}` : ''}` : '—'}
                  </td>
                  <td className="py-2.5 text-muted-foreground text-xs max-w-[220px] truncate">{p.notes || '—'}</td>
                  {canEdit && (
                    <td className="py-2.5 text-right">
                      <button onClick={() => remove(p.id)} title="Remove this payout" className="text-muted-foreground hover:text-red-500">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {msg && <p className="text-xs text-muted-foreground mt-3">{msg}</p>}
    </div>
  )
}

function Tile({ label, value, hint, tint, muted }: {
  label: string; value: string; hint: string; tint?: string; muted?: boolean
}) {
  return (
    <div className="bg-background border border-border rounded-lg p-3">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold ${tint || (muted ? 'text-muted-foreground' : 'text-foreground')}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground/70 mt-0.5 leading-snug">{hint}</div>
    </div>
  )
}
