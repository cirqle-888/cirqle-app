'use client'

import { useState } from 'react'
import type { DeviceEventRow, DeviceRow, ValuationRow } from '@/lib/profit-sharing/load'
import { DEVICE_CATEGORIES, DEVICE_CONDITIONS } from '@/lib/profit-sharing/device'
import {
  addDeviceEvent, calculateValuation, confirmValuation, createValuation, rejectValuation, reviewValuation, saveDevice,
} from './actions'
import { Badge, Button, Card, Empty, Field, STATUS_TONE, inputCls, inr, pct, useAction } from '../_components'

const OWNERSHIP: Record<string, string> = {
  employee_owned: 'Employee-owned (A)', company_owned: 'Company-owned, assigned (C)', transferred: 'Transferred to Cirqle (B)',
}

export default function DevicesClient({ today, policyApproved, members, devices, events, valuations }: {
  today: string; policyApproved: boolean; members: { id: string; label: string }[]
  devices: DeviceRow[]; events: DeviceEventRow[]; valuations: ValuationRow[]
}) {
  const { run, busy, host } = useAction()
  const label = new Map(members.map(m => [m.id, m.label]))
  return (
    <div className="space-y-6">
      {host}
      {!policyApproved && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          No device policy is approved (D11). Valuations can be drafted and calculated, but none can be confirmed until a policy is approved in Settings.
        </div>
      )}
      <Card title="Device register" subtitle="Employee-owned devices can be valued; company-owned devices never earn an employee value. Calculation alone never pays, invests or touches a payslip.">
        {devices.length === 0 ? <Empty>No devices registered.</Empty> : (
          <div className="space-y-3">
            {devices.map(d => (
              <DeviceRowView key={d.id} d={d} holder={label.get(d.memberId) ?? '—'} today={today}
                events={events.filter(e => e.deviceId === d.id)} valuations={valuations.filter(v => v.deviceId === d.id)} run={run} busy={busy} />
            ))}
          </div>
        )}
        <DeviceForm members={members} run={run} busy={busy} />
      </Card>
    </div>
  )
}

type Run = ReturnType<typeof useAction>['run']

function DeviceForm({ members, run, busy }: { members: { id: string; label: string }[]; run: Run; busy: string | null }) {
  const empty = { memberId: '', ownership: 'employee_owned', category: 'laptop', brand: '', model: '', specs: '', serialNumber: '', purchaseDate: '', purchasePriceInr: '', priceIsEstimated: false, condition: 'good', usageStart: '', usageEnd: '', notes: '' }
  const [f, setF] = useState(empty)
  const set = (k: keyof typeof f, v: string | boolean) => setF(x => ({ ...x, [k]: v }))
  return (
    <form className="mt-4 grid gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-4" onSubmit={async e => {
      e.preventDefault()
      const ok = await run('device', () => saveDevice({
        id: null, memberId: f.memberId, ownership: f.ownership as 'employee_owned', category: f.category as 'laptop',
        brand: f.brand || null, model: f.model || null, specs: f.specs || null, serialNumber: f.serialNumber || null,
        purchaseDate: f.purchaseDate || null, purchasePriceInr: f.purchasePriceInr === '' ? null : Number(f.purchasePriceInr),
        priceIsEstimated: f.priceIsEstimated, condition: f.condition as 'good', usageStart: f.usageStart || null, usageEnd: f.usageEnd || null,
        purchaseCashbookEntryId: null, notes: f.notes || null,
      }), 'Device registered')
      if (ok) setF(empty)
    }}>
      <Field label="Holder (employee)">
        <select className={inputCls} value={f.memberId} onChange={e => set('memberId', e.target.value)} required>
          <option value="">Choose…</option>
          {members.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </Field>
      <Field label="Ownership">
        <select className={inputCls} value={f.ownership} onChange={e => set('ownership', e.target.value)}>
          <option value="employee_owned">{OWNERSHIP.employee_owned}</option>
          <option value="company_owned">{OWNERSHIP.company_owned}</option>
        </select>
      </Field>
      <Field label="Category">
        <select className={inputCls} value={f.category} onChange={e => set('category', e.target.value)}>
          {DEVICE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Condition">
        <select className={inputCls} value={f.condition} onChange={e => set('condition', e.target.value)}>
          {DEVICE_CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Brand"><input className={inputCls} value={f.brand} onChange={e => set('brand', e.target.value)} /></Field>
      <Field label="Model"><input className={inputCls} value={f.model} onChange={e => set('model', e.target.value)} /></Field>
      <Field label="Specs"><input className={inputCls} value={f.specs} onChange={e => set('specs', e.target.value)} /></Field>
      <Field label="Serial (optional)"><input className={inputCls} value={f.serialNumber} onChange={e => set('serialNumber', e.target.value)} /></Field>
      <Field label="Purchase date"><input type="date" className={inputCls} value={f.purchaseDate} onChange={e => set('purchaseDate', e.target.value)} /></Field>
      <Field label="Purchase price (₹)" hint="If unknown: an equivalent new device’s price, marked estimated — always depreciated by age">
        <input type="number" step="0.01" min="0" className={inputCls} value={f.purchasePriceInr} onChange={e => set('purchasePriceInr', e.target.value)} />
      </Field>
      <Field label="Price is estimated">
        <input type="checkbox" checked={f.priceIsEstimated} onChange={e => set('priceIsEstimated', e.target.checked)} />
      </Field>
      <Field label="Used for Cirqle from" hint="Registration date proves nothing; record when Cirqle use began"><input type="date" className={inputCls} value={f.usageStart} onChange={e => set('usageStart', e.target.value)} /></Field>
      <div className="flex items-end"><Button type="submit" variant="primary" busy={busy === 'device'}>Register device</Button></div>
    </form>
  )
}

function DeviceRowView({ d, holder, today, events, valuations, run, busy }: {
  d: DeviceRow; holder: string; today: string; events: DeviceEventRow[]; valuations: ValuationRow[]; run: Run; busy: string | null
}) {
  const [ev, setEv] = useState({ kind: 'repair', eventDate: today, costInr: '', paidBy: 'employee', notes: '' })
  const [nv, setNv] = useState({ kind: 'usage', windowStart: '', windowEnd: '', asOf: today })
  return (
    <details className="rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none flex-wrap justify-between gap-2 px-3 py-2 text-sm">
        <span>{holder} · <span className="capitalize">{d.category}</span>{d.brand ? ` ${d.brand}` : ''}{d.model ? ` ${d.model}` : ''}</span>
        <span className="text-xs text-muted-foreground">{OWNERSHIP[d.ownership]} · {d.purchaseDate ?? 'no purchase date'} · {inr(d.purchasePriceInr)}{d.priceIsEstimated ? ' (estimated)' : ''} · {d.condition ?? '—'}</span>
      </summary>
      <div className="space-y-4 border-t border-border p-3">
        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Events</h3>
          {events.length === 0 ? <p className="text-xs text-muted-foreground">None.</p> : (
            <ul className="space-y-0.5 text-xs">{events.map(e => <li key={e.id}>{e.eventDate} · {e.kind}{e.costInr != null ? ` · ${inr(e.costInr)} paid by ${e.paidBy}` : ''}{e.notes ? ` · ${e.notes}` : ''}</li>)}</ul>
          )}
          <div className="mt-2 grid gap-2 md:grid-cols-6">
            <select className={inputCls} value={ev.kind} onChange={e => setEv(x => ({ ...x, kind: e.target.value }))}>
              {['repair', 'maintenance', 'condition', 'assigned', 'returned', 'note'].map(k => <option key={k} value={k}>{k}</option>)}
            </select>
            <input type="date" className={inputCls} value={ev.eventDate} onChange={e => setEv(x => ({ ...x, eventDate: e.target.value }))} />
            <input type="number" step="0.01" min="0" placeholder="Cost ₹" className={inputCls} value={ev.costInr} onChange={e => setEv(x => ({ ...x, costInr: e.target.value }))} />
            <select className={inputCls} value={ev.paidBy} onChange={e => setEv(x => ({ ...x, paidBy: e.target.value }))}>
              <option value="employee">Paid by employee</option><option value="company">Paid by Cirqle</option><option value="none">No cost</option>
            </select>
            <input placeholder="Note" className={inputCls} value={ev.notes} onChange={e => setEv(x => ({ ...x, notes: e.target.value }))} />
            <Button busy={busy === `ev${d.id}`} onClick={() => run(`ev${d.id}`, () => addDeviceEvent({
              deviceId: d.id, kind: ev.kind, eventDate: ev.eventDate, costInr: ev.costInr === '' ? null : Number(ev.costInr),
              paidBy: ev.paidBy as 'employee', notes: ev.notes || null,
            }), 'Event added')}>Add event</Button>
          </div>
        </div>

        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Valuations</h3>
          {valuations.length === 0 ? <p className="text-xs text-muted-foreground">None.</p> : (
            <div className="space-y-2">{valuations.map(v => <ValuationView key={v.id} v={v} run={run} busy={busy} />)}</div>
          )}
          {d.ownership === 'employee_owned' ? (
            <div className="mt-2 grid gap-2 md:grid-cols-5">
              <select className={inputCls} value={nv.kind} onChange={e => setNv(x => ({ ...x, kind: e.target.value }))}>
                <option value="usage">Usage (employee keeps it)</option><option value="transfer">Transfer to Cirqle</option>
              </select>
              {nv.kind === 'usage' ? <>
                <input type="date" className={inputCls} value={nv.windowStart} onChange={e => setNv(x => ({ ...x, windowStart: e.target.value }))} />
                <input type="date" className={inputCls} value={nv.windowEnd} onChange={e => setNv(x => ({ ...x, windowEnd: e.target.value }))} />
              </> : <input type="date" className={inputCls} value={nv.asOf} onChange={e => setNv(x => ({ ...x, asOf: e.target.value }))} />}
              <Button busy={busy === `nv${d.id}`} onClick={() => run(`nv${d.id}`, () => createValuation({
                deviceId: d.id, kind: nv.kind as 'usage', windowStart: nv.windowStart || null, windowEnd: nv.windowEnd || null, asOf: nv.asOf || null,
              }), 'Valuation drafted')}>New valuation</Button>
            </div>
          ) : <p className="mt-2 text-xs text-muted-foreground">Not employee-owned: no valuation (case {d.ownership === 'company_owned' ? 'C' : 'B, already transferred'}).</p>}
        </div>
      </div>
    </details>
  )
}

function ValuationView({ v, run, busy }: { v: ValuationRow; run: Run; busy: string | null }) {
  const [calc, setCalc] = useState({ market: '', evidence: '', verified: '', verifiedReason: '' })
  const [rev, setRev] = useState({ adjusted: v.proposedInr != null ? String(v.proposedInr) : '', reason: '', outcome: v.kind === 'usage' ? 'reimburse' : 'purchase' })
  const r = v.inputs?.result
  const open = ['draft', 'calculated', 'reviewed'].includes(v.status)
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{v.kind === 'usage' ? `Usage ${v.windowStart} → ${v.windowEnd}` : `Transfer on ${v.asOf}`} <Badge tone={STATUS_TONE[v.status] ?? 'muted'}>{v.status}</Badge>
          {v.usageBasis && <span className="ml-1"><Badge tone={v.usageBasis === 'verified' ? 'good' : 'warn'}>{v.usageBasis}</Badge></span>}
          {v.inputs?.policyStatus && v.inputs.policyStatus !== 'approved' && <span className="ml-1"><Badge tone="warn">{v.inputs.policyStatus} policy</Badge></span>}
        </span>
        <span className="tabular-nums">{v.adjustedInr != null ? <>{inr(v.adjustedInr)} <span className="text-xs text-muted-foreground">(proposed {inr(v.proposedInr)})</span></> : inr(v.proposedInr)}</span>
      </div>
      {r && (
        <p className="mt-1 text-xs text-muted-foreground">
          {v.kind === 'usage'
            ? <>Model value {inr(r.modelValueInr)} · value used {inr(r.valueUsedInr)} · remaining life {r.remainingLifeMonths} months · wear {inr(r.monthlyWearInr)}/month × {r.monthsUsed} months × business share {pct(r.businessShare)}{r.repairsInr ? ` + employee-paid repairs ${inr(r.repairsInr)} × share` : ''}
              {v.evidence && ` · evidence: ${v.evidence.deviceWorkDays} device-work days of ${v.evidence.availableDays} (${v.evidence.tasksConsidered} tasks) — task categories suggest the device kind, they do not prove which device was used`}</>
            : <>Model value on the transfer date {inr(r.modelValueInr)} · proposed {inr(r.proposedInr)}</>}
          {r.marketAboveTolerance && ' · resale value above tolerance (reason recorded)'}
          {v.adjustmentReason && ` · adjusted: ${v.adjustmentReason}`}
        </p>
      )}
      {open && (
        <div className="mt-2 grid gap-2 md:grid-cols-5">
          <input type="number" step="0.01" min="0" placeholder="Resale value ₹ (optional)" className={inputCls} value={calc.market} onChange={e => setCalc(x => ({ ...x, market: e.target.value }))} />
          <input placeholder="Resale evidence" className={inputCls} value={calc.evidence} onChange={e => setCalc(x => ({ ...x, evidence: e.target.value }))} />
          {v.kind === 'usage' && <>
            <input type="number" step="0.1" min="0" max="100" placeholder="Verified share % (optional)" className={inputCls} value={calc.verified} onChange={e => setCalc(x => ({ ...x, verified: e.target.value }))} />
            <input placeholder="Verification evidence" className={inputCls} value={calc.verifiedReason} onChange={e => setCalc(x => ({ ...x, verifiedReason: e.target.value }))} />
          </>}
          <Button busy={busy === `calc${v.id}`} onClick={() => run(`calc${v.id}`, () => calculateValuation({
            valuationId: v.id, marketValueInr: calc.market === '' ? null : Number(calc.market), marketEvidence: calc.evidence || null,
            verifiedShare: calc.verified === '' ? null : Number(calc.verified) / 100, verifiedReason: calc.verifiedReason || null,
          }), 'Calculated')}>{v.status === 'draft' ? 'Calculate' : 'Recalculate'}</Button>
        </div>
      )}
      {v.status === 'calculated' && (
        <div className="mt-2 grid gap-2 md:grid-cols-4">
          <input type="number" step="0.01" min="0" className={inputCls} value={rev.adjusted} onChange={e => setRev(x => ({ ...x, adjusted: e.target.value }))} />
          <input placeholder="Reason for any adjustment" className={inputCls} value={rev.reason} onChange={e => setRev(x => ({ ...x, reason: e.target.value }))} />
          <select className={inputCls} value={rev.outcome} onChange={e => setRev(x => ({ ...x, outcome: e.target.value }))}>
            {v.kind === 'usage'
              ? <><option value="reimburse">Reimburse (an expense)</option><option value="capital">Capital — needs an approved device agreement</option><option value="none">No settlement</option></>
              : <><option value="purchase">Cirqle buys it (an expense when paid)</option><option value="capital">In-kind capital — needs an approved agreement</option><option value="none">No settlement</option></>}
          </select>
          <Button variant="primary" busy={busy === `rev${v.id}`} onClick={() => run(`rev${v.id}`, () => reviewValuation({
            valuationId: v.id, adjustedInr: rev.adjusted === '' ? null : Number(rev.adjusted), adjustmentReason: rev.reason || null, outcome: rev.outcome as 'reimburse',
          }), 'Reviewed')}>Mark reviewed</Button>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {v.status === 'reviewed' && (
          <Button variant="primary" busy={busy === `conf${v.id}`} onClick={() => run(`conf${v.id}`, () => confirmValuation(v.id), 'Valuation confirmed — the cost counts in this period')}>Confirm</Button>
        )}
        {open && <Button variant="danger" busy={busy === `rej${v.id}`} onClick={() => run(`rej${v.id}`, () => rejectValuation(v.id), 'Valuation rejected')}>Reject</Button>}
      </div>
    </div>
  )
}
