'use client'

/**
 * Commission what-if planner.
 *
 * There are no commission agreements in the system — you dial a percentage,
 * see what it would cost, and decide. Nothing here is owed to anyone: it's a
 * calculator, not a payable. The rate can be saved onto the partner so the next
 * session starts where you left off, and re-planned any time.
 *
 * The base deliberately EXCLUDES pass-through spend (ad budgets, rebilled
 * expenses). Invoicing ₹1,18,000 of which ₹1,00,000 is Meta ad spend means you
 * earned ₹18,000 — paying commission on the ₹1,18,000 would hand over most of
 * what you actually made. Profit is shown alongside every figure as the
 * affordability guardrail: what share of the margin is this rate giving away?
 */

import { useState, useMemo } from 'react'
import { Percent, Save, TrendingDown, AlertTriangle } from 'lucide-react'
import { setPartnerCommissionRate } from '@/app/(dashboard)/dashboard/partners/actions'
import CommissionRegister from './commission-register'
import type { PartnerClientRow, CommissionPayment } from '@/lib/partners/queries'

type Basis = 'net_collected' | 'net_invoiced' | 'profit'

const BASIS_LABEL: Record<Basis, string> = {
  net_collected: 'Net collected',
  net_invoiced:  'Net invoiced',
  profit:        'Profit',
}
const BASIS_HINT: Record<Basis, string> = {
  net_collected: 'Money actually received, minus pass-through spend. Pay only on cash in hand.',
  net_invoiced:  'Everything billed, minus pass-through spend — earned on invoicing, before the client pays.',
  profit:        'Contribution margin. Safest for you, but swings on your own staff costs.',
}

const fmt = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

interface Row {
  clientId: string
  clientName: string
  /** What the commission is charged on, for money already received. */
  baseNow: number
  /** Same, for money still outstanding — payable when it lands. */
  baseLater: number
  profit: number
  badDebt: number
  commissionNow: number
  commissionLater: number
  clawback: number
  profitAfter: number
}

function computeRows(clients: PartnerClientRow[], pct: number, basis: Basis, clawbackOn: boolean): Row[] {
  return clients.map(c => {
    const netInvoiced = c.invoicedInr - c.directCostsInr
    // Pass-through spend is spread across the invoice, so the collected slice of
    // it scales with how much of the invoice has been paid.
    const collectedRatio = c.invoicedInr > 0 ? c.collectedInr / c.invoicedInr : 0
    const netCollected = c.collectedInr - c.directCostsInr * collectedRatio

    let baseNow: number
    let baseLater: number
    if (basis === 'net_collected') {
      baseNow = netCollected
      baseLater = netInvoiced - netCollected
    } else if (basis === 'net_invoiced') {
      baseNow = netInvoiced
      baseLater = 0
    } else {
      baseNow = c.profitInr * collectedRatio
      baseLater = c.profitInr - baseNow
    }

    const commissionNow = Math.max(0, baseNow) * pct / 100
    const commissionLater = Math.max(0, baseLater) * pct / 100

    // Optional clawback: the partner's share of what the client never paid.
    // Capped at the commission itself — you can withhold what you owe them, you
    // can't invoice them for the client's default.
    const clawback = clawbackOn
      ? Math.min(commissionNow + commissionLater, c.badDebtInr * pct / 100)
      : 0

    return {
      clientId: c.id,
      clientName: c.name,
      baseNow: Math.max(0, baseNow),
      baseLater: Math.max(0, baseLater),
      profit: c.profitInr,
      badDebt: c.badDebtInr,
      commissionNow,
      commissionLater,
      clawback,
      profitAfter: c.profitInr - commissionNow - commissionLater + clawback,
    }
  })
}

export default function CommissionPlanner({ partnerId, partnerName, clients, savedPercent, payments, canEdit }: {
  partnerId: string
  partnerName: string
  clients: PartnerClientRow[]
  savedPercent: number | null
  payments: CommissionPayment[]
  canEdit: boolean
}) {
  const [pctInput, setPctInput] = useState(savedPercent != null ? String(savedPercent) : '10')
  const [basis, setBasis] = useState<Basis>('net_collected')
  const [clawbackOn, setClawbackOn] = useState(false)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const pct = Math.min(100, Math.max(0, parseFloat(pctInput) || 0))
  const rows = useMemo(() => computeRows(clients, pct, basis, clawbackOn), [clients, pct, basis, clawbackOn])

  const sum = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0)
  const totalNow = sum(r => r.commissionNow)
  const totalLater = sum(r => r.commissionLater)
  const totalProfit = sum(r => r.profit)
  const totalBadDebt = sum(r => r.badDebt)
  const totalClawback = sum(r => r.clawback)
  const totalCommission = totalNow + totalLater - totalClawback
  const profitAfter = totalProfit - totalCommission
  const shareOfMargin = totalProfit > 0 ? (totalCommission / totalProfit) * 100 : 0
  const eatsProfit = totalCommission > totalProfit
  // What the register measures "paid" against: commission on money in hand,
  // less any clawback you've decided to withhold.
  const earnedNow = Math.max(0, totalNow - totalClawback)

  async function save() {
    setSaving(true)
    const res = await setPartnerCommissionRate(partnerId, pct)
    setSaving(false)
    setMsg(res.ok ? `Saved ${pct}% as ${partnerName}'s rate — change it any time.` : (res.error || 'Could not save.'))
  }

  return (
    <div className="bg-secondary border border-border rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Percent className="w-4 h-4 text-muted-foreground" /> Commission Planner
        </h2>
        {savedPercent != null && (
          <span className="text-[10px] text-muted-foreground">Saved rate: {savedPercent}%</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        A calculator, not an agreement — nothing here is owed until you settle it.
      </p>

      {/* Controls */}
      <div className="flex items-end gap-3 flex-wrap mb-4">
        <div>
          <label className="block text-[10px] font-medium text-muted-foreground mb-1">Commission %</label>
          <div className="flex items-center gap-1">
            <input
              type="number" min="0" max="100" step="0.5"
              value={pctInput}
              onChange={e => { setPctInput(e.target.value); setMsg(null) }}
              className="w-24 text-sm bg-background border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        </div>

        <div className="flex-1 min-w-[240px]">
          <label className="block text-[10px] font-medium text-muted-foreground mb-1">Charged on</label>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(Object.keys(BASIS_LABEL) as Basis[]).map(b => (
              <button
                key={b}
                onClick={() => setBasis(b)}
                title={BASIS_HINT[b]}
                className={`text-[10px] font-medium px-2 py-1 rounded-full border transition-colors ${
                  basis === b
                    ? 'bg-violet-500/15 border-violet-500/40 text-violet-600 dark:text-violet-300'
                    : 'border-border/40 text-muted-foreground hover:text-foreground'
                }`}
              >{BASIS_LABEL[b]}</button>
            ))}
          </div>
        </div>

        {canEdit && (
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-border text-foreground hover:bg-background disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save as rate'}
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground -mt-2 mb-3">{BASIS_HINT[basis]}</p>

      {/* Bad debt — only offered when there is any to argue about. */}
      {totalBadDebt > 0 && (
        <label className="flex items-start gap-2 mb-4 cursor-pointer rounded-lg border border-border bg-background/60 px-3 py-2">
          <input
            type="checkbox"
            checked={clawbackOn}
            onChange={e => setClawbackOn(e.target.checked)}
            className="mt-0.5 accent-violet-500"
          />
          <span className="text-xs text-foreground">
            Claw back the partner&apos;s share of bad debt
            <span className="block text-[10px] text-muted-foreground mt-0.5">
              {fmt(totalBadDebt)} was written off on their clients. Withholding {pct}% of it deducts {fmt(totalClawback || totalBadDebt * pct / 100)} from
              what they&apos;re owed — capped at the commission itself, since a client&apos;s default isn&apos;t a debt the partner owes you.
            </span>
          </span>
        </label>
      )}

      {/* Headline */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        <Tile label="Give now" value={fmt(totalNow)} hint="On money already collected" tint="text-foreground" />
        <Tile label="Give later" value={fmt(totalLater)} hint="When the outstanding lands" tint="text-muted-foreground" />
        <Tile
          label="Bad debt (loss)"
          value={fmt(totalBadDebt)}
          hint={clawbackOn && totalClawback > 0 ? `−${fmt(totalClawback)} clawed back` : 'Written off — already in the margin'}
          tint={totalBadDebt > 0 ? 'text-red-500' : 'text-muted-foreground'}
        />
        <Tile
          label="Total commission"
          value={fmt(totalCommission)}
          hint={totalProfit > 0 ? `${shareOfMargin.toFixed(1)}% of your margin` : 'No margin to compare against'}
          tint={eatsProfit ? 'text-red-500' : 'text-foreground'}
        />
        <Tile
          label="Profit after commission"
          value={fmt(profitAfter)}
          hint={`from ${fmt(totalProfit)} margin`}
          tint={profitAfter < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}
        />
      </div>

      {eatsProfit && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 mb-4 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <p>At {pct}% you would pay {fmt(totalCommission)} on {fmt(totalProfit)} of margin — this rate costs more than the business earns from {partnerName}&apos;s clients.</p>
        </div>
      )}

      {/* Per-client */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="pb-2 font-medium">Client</th>
              <th className="pb-2 font-medium text-right">Base (collected)</th>
              <th className="pb-2 font-medium text-right">Base (pending)</th>
              <th className="pb-2 font-medium text-right">Give now</th>
              <th className="pb-2 font-medium text-right">Give later</th>
              {totalBadDebt > 0 && <th className="pb-2 font-medium text-right">Bad debt</th>}
              <th className="pb-2 font-medium text-right">Profit after</th>
              <th className="pb-2 font-medium text-right">% of margin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const total = r.commissionNow + r.commissionLater - r.clawback
              const share = r.profit > 0 ? (total / r.profit) * 100 : 0
              const over = total > r.profit
              return (
                <tr key={r.clientId} className="border-b border-border/50 last:border-0">
                  <td className="py-2.5 text-foreground">{r.clientName}</td>
                  <td className="py-2.5 text-right text-muted-foreground tabular-nums">{fmt(r.baseNow)}</td>
                  <td className="py-2.5 text-right text-muted-foreground tabular-nums">{fmt(r.baseLater)}</td>
                  <td className="py-2.5 text-right text-foreground font-medium tabular-nums">{fmt(r.commissionNow)}</td>
                  <td className="py-2.5 text-right text-muted-foreground tabular-nums">{fmt(r.commissionLater)}</td>
                  {totalBadDebt > 0 && (
                    <td className="py-2.5 text-right tabular-nums text-red-500">
                      {r.badDebt > 0 ? fmt(r.badDebt) : '—'}
                      {r.clawback > 0 && <span className="text-[10px] text-muted-foreground ml-1">−{fmt(r.clawback)}</span>}
                    </td>
                  )}
                  <td className={`py-2.5 text-right tabular-nums font-medium ${r.profitAfter < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {fmt(r.profitAfter)}
                  </td>
                  <td className={`py-2.5 text-right tabular-nums ${over ? 'text-red-500' : 'text-muted-foreground'}`}>
                    {r.profit > 0 ? `${share.toFixed(1)}%` : '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-muted-foreground mt-3 flex items-start gap-1.5">
        <TrendingDown className="w-3 h-3 shrink-0 mt-0.5" />
        Pass-through spend (ad budgets, rebilled expenses) is excluded from every base — you never pay commission on money that goes straight out to Meta or a vendor.
      </p>

      {msg && <p className="text-xs text-muted-foreground mt-2">{msg}</p>}

      {/* The register lives inside the planner because "pending" only means
          anything relative to the rate currently dialled in above. */}
      <div className="mt-4">
        <CommissionRegister
          partnerId={partnerId}
          payments={payments}
          earnedNow={earnedNow}
          plannerPercent={pct}
          plannerBasis={basis}
          canEdit={canEdit}
        />
      </div>
    </div>
  )
}

function Tile({ label, value, hint, tint }: { label: string; value: string; hint: string; tint: string }) {
  return (
    <div className="bg-background border border-border rounded-lg p-3">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold ${tint}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground/70 mt-0.5 leading-snug">{hint}</div>
    </div>
  )
}
