'use client'

import { useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import { planQuote, type PlanRefs } from '@/lib/quote-planner/compute'
import { historicalShares } from '@/lib/quote-planner/shares'
import type { PlanLine, QuotePlan, ShareOverride } from '@/lib/quote-planner/types'
import type { Currency, ContributionGroup, Parameter } from '@/types'
import { formatINR, getCurrencySymbol } from '@/lib/calculations/currency'
import { saveQuotePlan } from './actions'

/**
 * The planner screen.
 *
 * Every number shown comes from `planQuote()`, which calls the real commission
 * engine. Nothing is computed in this file — a figure invented here would be a
 * figure that disagrees with payroll.
 *
 * EMPLOYEES ARE CQIDs. No name is fetched, so none can be rendered.
 */

interface ClientRow { id: string; name: string; default_currency: Currency | null }
interface ServiceRow { id: string; name: string; default_price: number | null }
interface EmployeeRow { id: string; cqid: string; performance_rating: number | null }
interface PricingRow {
  client_id: string; service_id: string
  price: number | null; currency: Currency | null; commission_percentage: number | null
}
interface RateRow { currency: Currency; rate_to_inr: number }
interface PlanRow { id: string; name: string; client_id: string | null; status: string; currency: Currency; term_months: number }
interface ScoreRow { task_id: string | null; employee_id: string; score_percentage: number | null }
interface TaskRow { id: string; service_id: string | null }

interface Props {
  canManage: boolean
  clients: ClientRow[]
  services: ServiceRow[]
  groups: ContributionGroup[]
  parameters: Parameter[]
  employees: EmployeeRow[]
  pricings: PricingRow[]
  rates: RateRow[]
  plans: PlanRow[]
  scores: ScoreRow[]
  tasks: TaskRow[]
}

let seq = 0
const nextId = (p: string) => `${p}-${++seq}-${Date.now().toString(36)}`

export default function QuotePlannerClient(props: Props) {
  const { clients, services, groups, parameters, employees, pricings, rates } = props

  const rateMap = useMemo(() => {
    const m: Record<string, number> = { INR: 1 }
    for (const r of rates) m[r.currency] = Number(r.rate_to_inr) || 1
    return m
  }, [rates])

  const [plan, setPlan] = useState<QuotePlan>(() => ({
    id: nextId('new'), clientId: null, name: 'New quote', status: 'draft',
    currency: 'INR', termMonths: 12, lines: [], shares: [], ratings: {},
    costs: [], includeOverheads: false, quotationId: null, notes: '',
  }))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const patch = (p: Partial<QuotePlan>) => setPlan(prev => ({ ...prev, ...p }))

  /** The matrix price and commission for a client+service, or the fallbacks. */
  const matrixFor = (serviceId: string) => {
    const row = pricings.find(p => p.client_id === plan.clientId && p.service_id === serviceId)
    const svc = services.find(s => s.id === serviceId)
    return {
      price: row?.price ?? svc?.default_price ?? null,
      currency: (row?.currency ?? plan.currency) as Currency,
      // The same fallback every caller of calculateCommission uses.
      commissionPct: row?.commission_percentage ?? 50,
    }
  }

  const addLine = (serviceId: string) => {
    const m = matrixFor(serviceId)
    const line: PlanLine = {
      id: nextId('line'), serviceId, monthlyQuantity: 1,
      unitPrice: m.price ?? 0, currency: plan.currency,
      matrixUnitPrice: m.price, commissionPct: m.commissionPct,
      displayOrder: plan.lines.length,
    }
    // Seed the shares from what these people actually averaged on this service.
    const hist = historicalShares({
      scores: props.scores, tasks: props.tasks, serviceId,
    })
    const firstParam = parameters[0]
    const shares: ShareOverride[] = firstParam
      ? hist.map(h => ({ lineId: line.id, employeeId: h.employeeId, parameterId: firstParam.id, sharePct: h.sharePct }))
      : []
    patch({ lines: [...plan.lines, line], shares: [...plan.shares, ...shares] })
  }

  const result = useMemo(() => {
    const refs: PlanRefs = {
      employees: employees.map(e => ({
        id: e.id, cqid: e.cqid, performanceRating: Number(e.performance_rating) || 100,
      })),
      groups, parameters, toolsByService: {},
      rateToInr: rateMap[plan.currency] ?? 1,
    }
    return planQuote(plan, refs)
  }, [plan, employees, groups, parameters, rateMap])

  const sym = getCurrencySymbol(plan.currency)
  const foreign = plan.currency !== 'INR'

  async function onSave() {
    setSaving(true); setMessage(null)
    const out = await saveQuotePlan(plan)
    setSaving(false)
    if (!out.ok) { setMessage(out.error || 'Could not save.'); return }
    if (out.data) patch({ id: out.data.id })
    setMessage('Saved.')
  }

  return (
    <div>
      <Header title="Quote Planner" subtitle="Price a proposal and see what it leaves" />

      <div className="p-4 space-y-4 max-w-6xl">
        {/* ── The quote ─────────────────────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <label className="text-xs text-muted-foreground">
              Plan name
              <input className="field mt-1 w-full" value={plan.name}
                onChange={e => patch({ name: e.target.value })} />
            </label>
            <label className="text-xs text-muted-foreground">
              Client
              <select className="field mt-1 w-full" value={plan.clientId ?? ''}
                onChange={e => patch({ clientId: e.target.value || null })}>
                <option value="">Pick a client…</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Quote currency
              <select className="field mt-1 w-full" value={plan.currency}
                onChange={e => patch({ currency: e.target.value as Currency })}>
                {Object.keys(rateMap).map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Term (months)
              <input type="number" min={0} className="field mt-1 w-full" value={plan.termMonths}
                onChange={e => patch({ termMonths: Number(e.target.value) || 0 })} />
            </label>
          </div>

          <div className="flex items-center gap-2">
            <select className="field h-9 text-sm" value=""
              onChange={e => { if (e.target.value) addLine(e.target.value) }}>
              <option value="">Add a service…</option>
              {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <span className="text-[11px] text-muted-foreground">
              Price and pool % are seeded from this client&apos;s matrix.
            </span>
          </div>

          {result.lines.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="text-left py-1">Service</th>
                  <th className="text-right">Qty/mo</th>
                  <th className="text-right">Unit</th>
                  <th className="text-right">Pool %</th>
                  <th className="text-right">Monthly</th>
                  <th className="text-right">vs matrix</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((l, i) => {
                  const r = result.lines[i]
                  const name = services.find(s => s.id === l.serviceId)?.name ?? '—'
                  const set = (p: Partial<PlanLine>) => patch({
                    lines: plan.lines.map(x => x.id === l.id ? { ...x, ...p } : x),
                  })
                  return (
                    <tr key={l.id} className="border-t border-border">
                      <td className="py-1.5">{name}</td>
                      <td className="text-right">
                        <input type="number" min={0} className="field w-16 text-right" value={l.monthlyQuantity}
                          onChange={e => set({ monthlyQuantity: Number(e.target.value) || 0 })} />
                      </td>
                      <td className="text-right">
                        <input type="number" min={0} className="field w-24 text-right" value={l.unitPrice}
                          onChange={e => set({ unitPrice: Number(e.target.value) || 0 })} />
                      </td>
                      <td className="text-right">
                        <input type="number" min={0} max={100} className="field w-16 text-right" value={l.commissionPct}
                          onChange={e => set({ commissionPct: Number(e.target.value) || 0 })} />
                      </td>
                      <td className="text-right tabular-nums">{formatINR(r.monthlyQuotedInr)}</td>
                      <td className={`text-right tabular-nums ${(r.vsMatrixInr ?? 0) < 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                        {r.vsMatrixInr === null ? '—' : formatINR(r.vsMatrixInr)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          <div className="flex flex-wrap gap-6 pt-2 border-t border-border text-sm">
            <Figure label="Monthly" inr={result.monthlyQuotedInr}
              foreign={foreign ? `${sym}${result.monthlyQuoted.toLocaleString('en-IN')}` : null} />
            <Figure label={`Over ${result.termMonths} months`} inr={result.termQuotedInr}
              foreign={foreign ? `${sym}${result.termQuoted.toLocaleString('en-IN')}` : null} />
            {foreign && (
              <span className="text-[11px] text-muted-foreground self-end">
                at {result.rateToInr} INR per {plan.currency}
              </span>
            )}
          </div>
        </section>

        {/* ── Who earns what ────────────────────────────────────────────── */}
        {result.earnings.length > 0 && (
          <section className="bg-card border border-border rounded-xl p-4">
            <h2 className="text-sm font-semibold mb-2">Employee earnings</h2>
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="text-left py-1">CQID</th>
                  <th className="text-right">Performance %</th>
                  <th className="text-right">Per month</th>
                  <th className="text-right">Over term</th>
                </tr>
              </thead>
              <tbody>
                {result.earnings.map(e => (
                  <tr key={e.employeeId} className="border-t border-border">
                    <td className="py-1.5 font-mono text-xs">{e.employeeCqid}</td>
                    <td className="text-right">
                      <input type="number" min={0} max={100} className="field w-20 text-right"
                        value={plan.ratings[e.employeeId] ?? e.ratingPct}
                        onChange={ev => patch({
                          ratings: { ...plan.ratings, [e.employeeId]: Number(ev.target.value) || 0 },
                        })} />
                    </td>
                    <td className="text-right tabular-nums">{formatINR(e.monthlyInr)}</td>
                    <td className="text-right tabular-nums">{formatINR(e.termInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-muted-foreground mt-2">
              Shares start from what each person actually averaged on this service.
              Lowering a performance % does not shrink the pool — it moves the difference into margin.
            </p>
          </section>
        )}

        {/* ── Margin ────────────────────────────────────────────────────── */}
        <section className="bg-card border border-border rounded-xl p-4 space-y-1 text-sm">
          <h2 className="text-sm font-semibold mb-2">Margin over the term</h2>
          <Row label="Quoted" value={result.margin.quotedInr} />
          <Row label="Employee earnings" value={-result.margin.earningsInr} />
          {result.margin.plannedCostsInr > 0 && <Row label="Planned costs" value={-result.margin.plannedCostsInr} />}
          <Row label="Deal margin" value={result.margin.dealMarginInr} strong
            suffix={`${result.margin.dealMarginPct}%`} />

          <label className="flex items-center gap-2 pt-3 text-[11px] text-muted-foreground">
            <input type="checkbox" className="w-auto" checked={plan.includeOverheads}
              onChange={e => patch({ includeOverheads: e.target.checked })} />
            Also apportion company salaries and expenses to this deal
          </label>
          {result.margin.overheadsIncluded && (
            <>
              <Row label="Base salaries (allocated)" value={-result.margin.allocatedSalariesInr} muted />
              <Row label="Expenses (allocated)" value={-result.margin.allocatedExpensesInr} muted />
              <Row label="Operating result" value={result.margin.operatingResultInr} strong
                suffix={`${result.margin.operatingResultPct}%`} />
              <p className="text-[11px] text-muted-foreground pt-1">
                Allocated figures are this deal&apos;s share of company-wide numbers, not measurements of it.
              </p>
            </>
          )}
        </section>

        {result.notes.length > 0 && (
          <ul className="text-[11px] text-amber-500 space-y-1">
            {result.notes.map(n => <li key={n}>· {n}</li>)}
          </ul>
        )}

        {props.canManage && (
          <div className="flex items-center gap-3">
            <button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</button>
            {message && <span className="text-[11px] text-muted-foreground">{message}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function Figure({ label, inr, foreign }: { label: string; inr: number; foreign: string | null }) {
  return (
    <div>
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{formatINR(inr)}</div>
      {foreign && <div className="text-[11px] text-muted-foreground tabular-nums">{foreign}</div>}
    </div>
  )
}

function Row({ label, value, strong, muted, suffix }: {
  label: string; value: number; strong?: boolean; muted?: boolean; suffix?: string
}) {
  return (
    <div className={`flex justify-between ${strong ? 'font-semibold border-t border-border pt-1 mt-1' : ''} ${muted ? 'text-muted-foreground' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">
        {formatINR(value)}{suffix ? <span className="text-muted-foreground ml-2">{suffix}</span> : null}
      </span>
    </div>
  )
}
