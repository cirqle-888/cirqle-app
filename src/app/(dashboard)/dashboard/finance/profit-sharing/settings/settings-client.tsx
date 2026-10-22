'use client'

import { useState } from 'react'
import type { ReserveMovement, SettingsVersion } from '@/lib/profit-sharing/load'
import {
  DEVICE_CATEGORIES, DEVICE_CONDITIONS, PROVISIONAL_DEVICE_POLICY, type DeviceNeed, type DevicePolicy,
} from '@/lib/profit-sharing/device'
import { addSettingsVersion, releaseReserve, saveDevicePolicy } from '../actions'
import { Badge, Button, Card, Empty, Field, Table, inputCls, inr, td, tdNum, useAction } from '../_components'

export default function SettingsClient({ today, versions, lastConfirmedEnd, serviceCategories, draftPolicy, approvedAt, reserve, reserveBalanceInr }: {
  today: string
  versions: SettingsVersion[]
  lastConfirmedEnd: string | null
  serviceCategories: { id: string; name: string }[]
  draftPolicy: DevicePolicy | null
  approvedAt: string | null
  reserve: ReserveMovement[]
  reserveBalanceInr: number
}) {
  const { run, busy, host } = useAction()
  return (
    <div className="space-y-6">
      {host}
      <DistributionCard versions={versions} lastConfirmedEnd={lastConfirmedEnd} today={today} run={run} busy={busy} />
      <ReserveCard reserve={reserve} balance={reserveBalanceInr} today={today} run={run} busy={busy} />
      <DevicePolicyCard draft={draftPolicy} approvedAt={approvedAt} serviceCategories={serviceCategories} run={run} busy={busy} />
    </div>
  )
}

type Run = ReturnType<typeof useAction>['run']

function DistributionCard({ versions, lastConfirmedEnd, today, run, busy }: {
  versions: SettingsVersion[]; lastConfirmedEnd: string | null; today: string; run: Run; busy: string | null
}) {
  const current = versions[0]
  const nextMonth = (() => {
    const base = lastConfirmedEnd && lastConfirmedEnd >= today ? lastConfirmedEnd : today
    const [y, m] = base.split('-').map(Number)
    return `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`
  })()
  const [f, setF] = useState({
    effectiveMonth: nextMonth,
    distributionPct: String(current?.distributionPct ?? 50), capitalSharePct: String(current?.capitalSharePct ?? 50),
    reservePct: String(current?.reservePct ?? 50), toleranceInr: String(current?.toleranceInr ?? 1),
    adPrepaidBlockDays: String(current?.adPrepaidBlockDays ?? 60), passthroughWarnDays: String(current?.passthroughWarnDays ?? 90), note: '',
  })
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))
  const total = Number(f.capitalSharePct) + Number(f.reservePct)
  return (
    <Card title="Distribution settings" subtitle="Versioned: a change adds a version from a month onwards and never alters a confirmed period. Capital Share + Business Reserve must total exactly 100%.">
      <Table head={['From', 'Distributed', 'Capital Share', 'Reserve', 'Tolerance', 'Ad funding blocks after', 'Device policy', 'Note']}>
        {versions.map(v => (
          <tr key={v.id} className="border-b border-border/60">
            <td className={td}>{v.effectiveFrom === '2000-01-01' ? 'Start' : v.effectiveFrom.slice(0, 7)}</td>
            <td className={tdNum}>{v.distributionPct}%</td>
            <td className={tdNum}>{v.capitalSharePct}%</td>
            <td className={tdNum}>{v.reservePct}%</td>
            <td className={tdNum}>{inr(v.toleranceInr)}</td>
            <td className={tdNum}>{v.adPrepaidBlockDays} days</td>
            <td className={td}>{v.devicePolicyApprovedAt ? <Badge tone="good">approved</Badge> : v.devicePolicy ? <Badge tone="warn">draft</Badge> : '—'}</td>
            <td className={`${td} text-xs text-muted-foreground`}>{v.note ?? ''}</td>
          </tr>
        ))}
      </Table>
      <form className="mt-4 grid gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-4" onSubmit={e => {
        e.preventDefault()
        void run('settings', () => addSettingsVersion({
          effectiveFrom: `${f.effectiveMonth}-01`, distributionPct: Number(f.distributionPct), capitalSharePct: Number(f.capitalSharePct),
          reservePct: Number(f.reservePct), toleranceInr: Number(f.toleranceInr), adPrepaidBlockDays: Number(f.adPrepaidBlockDays),
          passthroughWarnDays: Number(f.passthroughWarnDays), note: f.note || null,
        }), 'New settings version added')
      }}>
        <Field label="From month" hint={lastConfirmedEnd ? `Must start after ${lastConfirmedEnd}` : undefined}>
          <input type="month" className={inputCls} value={f.effectiveMonth} onChange={e => set('effectiveMonth', e.target.value)} required />
        </Field>
        <Field label="Distribution rate (% of eligible profit)"><input type="number" step="0.01" min="0" max="100" className={inputCls} value={f.distributionPct} onChange={e => set('distributionPct', e.target.value)} /></Field>
        <Field label="Capital Share (% of pool)"><input type="number" step="0.01" min="0" max="100" className={inputCls} value={f.capitalSharePct}
          onChange={e => { set('capitalSharePct', e.target.value); set('reservePct', String(Math.round((100 - Number(e.target.value)) * 100) / 100)) }} /></Field>
        <Field label="Business Reserve (% of pool)" hint={total === 100 ? 'Totals 100%' : `Totals ${total}% — must be 100%`}>
          <input type="number" step="0.01" min="0" max="100" className={inputCls} value={f.reservePct} onChange={e => set('reservePct', e.target.value)} />
        </Field>
        <Field label="Reconciliation tolerance (₹)"><input type="number" step="0.01" min="0" className={inputCls} value={f.toleranceInr} onChange={e => set('toleranceInr', e.target.value)} /></Field>
        <Field label="Unassigned ad funding blocks after (days)"><input type="number" min="1" className={inputCls} value={f.adPrepaidBlockDays} onChange={e => set('adPrepaidBlockDays', e.target.value)} /></Field>
        <Field label="Pass-through warning after (days)"><input type="number" min="1" className={inputCls} value={f.passthroughWarnDays} onChange={e => set('passthroughWarnDays', e.target.value)} /></Field>
        <Field label="Note"><input className={inputCls} value={f.note} onChange={e => set('note', e.target.value)} /></Field>
        <div className="flex items-end"><Button type="submit" variant="primary" busy={busy === 'settings'} disabled={total !== 100}>Add version</Button></div>
      </form>
    </Card>
  )
}

function ReserveCard({ reserve, balance, today, run, busy }: { reserve: ReserveMovement[]; balance: number; today: string; run: Run; busy: string | null }) {
  const [f, setF] = useState({ amountInr: '', movedOn: today, reason: '' })
  return (
    <Card title={`Business Reserve — ${inr(balance)}`} subtitle="An internal earmark of retained profit (D9). It creates no cash, does not absorb losses and does not fund payouts. A release needs a reason and Admin approval.">
      {reserve.length === 0 ? <Empty>No reserve movements yet.</Empty> : (
        <Table head={['Date', 'Movement', 'Amount', 'Reason']}>
          {reserve.map(m => (
            <tr key={m.id} className="border-b border-border/60">
              <td className={td}>{m.movedOn}</td>
              <td className={td}>{m.kind}</td>
              <td className={tdNum}>{m.kind === 'release' ? '−' : ''}{inr(m.amountInr)}</td>
              <td className={`${td} text-xs text-muted-foreground`}>{m.reason ?? ''}</td>
            </tr>
          ))}
        </Table>
      )}
      <form className="mt-4 grid gap-3 md:grid-cols-4" onSubmit={async e => {
        e.preventDefault()
        if (await run('release', () => releaseReserve({ amountInr: Number(f.amountInr), movedOn: f.movedOn, reason: f.reason }), 'Reserve released')) setF({ amountInr: '', movedOn: today, reason: '' })
      }}>
        <Field label="Release (₹)"><input type="number" step="0.01" min="0.01" className={inputCls} value={f.amountInr} onChange={e => setF(x => ({ ...x, amountInr: e.target.value }))} required /></Field>
        <Field label="Date"><input type="date" className={inputCls} value={f.movedOn} onChange={e => setF(x => ({ ...x, movedOn: e.target.value }))} /></Field>
        <Field label="Reason"><input className={inputCls} value={f.reason} onChange={e => setF(x => ({ ...x, reason: e.target.value }))} required /></Field>
        <div className="flex items-end"><Button type="submit" busy={busy === 'release'}>Release</Button></div>
      </form>
    </Card>
  )
}

function DevicePolicyCard({ draft, approvedAt, serviceCategories, run, busy }: {
  draft: DevicePolicy | null; approvedAt: string | null; serviceCategories: { id: string; name: string }[]; run: Run; busy: string | null
}) {
  const [p, setP] = useState<DevicePolicy>(draft ?? PROVISIONAL_DEVICE_POLICY)
  const [note, setNote] = useState('')
  const setLife = (c: string, v: string) => setP(x => ({ ...x, lifeMonths: { ...x.lifeMonths, [c]: Number(v) } }))
  const setShare = (c: string, v: string) => setP(x => ({ ...x, dailyWorkShare: { ...x.dailyWorkShare, [c]: Number(v) / 100 } }))
  const setCond = (c: string, v: string) => setP(x => ({ ...x, conditionFactors: { ...x.conditionFactors, [c]: Number(v) } }))
  const setNeed = (id: string, v: DeviceNeed) => setP(x => ({ ...x, deviceNeedMap: { ...x.deviceNeedMap, [id]: v } }))
  return (
    <Card title="Device valuation policy (D11)"
      subtitle={approvedAt
        ? `Approved ${approvedAt.slice(0, 10)}. Changes are saved as a new version.`
        : 'No policy is approved. Valuations can be drafted and calculated, but none can be confirmed until you approve one. The values below are provisional.'}>
      <div className="space-y-4">
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[520px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground"><th className="px-2 py-1">Category</th><th className="px-2 py-1">Useful life (months)</th><th className="px-2 py-1">Daily work share (%)</th></tr></thead>
            <tbody>
              {DEVICE_CATEGORIES.map(c => (
                <tr key={c}>
                  <td className="px-2 py-1 capitalize">{c}</td>
                  <td className="px-2 py-1"><input type="number" min="1" className={inputCls} value={p.lifeMonths[c]} onChange={e => setLife(c, e.target.value)} /></td>
                  <td className="px-2 py-1"><input type="number" min="0" max="100" className={inputCls} value={Math.round(p.dailyWorkShare[c] * 10000) / 100} onChange={e => setShare(c, e.target.value)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Floor (% of price)"><input type="number" min="0" max="100" className={inputCls} value={p.floorPct} onChange={e => setP(x => ({ ...x, floorPct: Number(e.target.value) }))} /></Field>
          <Field label="Minimum remaining life (months)"><input type="number" min="1" className={inputCls} value={p.minRemainingMonths} onChange={e => setP(x => ({ ...x, minRemainingMonths: Number(e.target.value) }))} /></Field>
          <Field label="Resale above model value needs a reason at (×)"><input type="number" step="0.1" min="1" className={inputCls} value={p.marketToleranceMultiple} onChange={e => setP(x => ({ ...x, marketToleranceMultiple: Number(e.target.value) }))} /></Field>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          {DEVICE_CONDITIONS.map(c => (
            <Field key={c} label={`Condition factor — ${c}`}><input type="number" step="0.01" min="0.01" max="1" className={inputCls} value={p.conditionFactors[c]} onChange={e => setCond(c, e.target.value)} /></Field>
          ))}
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Which device each service category needs (evidence only — never proof of which device was used)</p>
          <div className="grid gap-2 md:grid-cols-3">
            {serviceCategories.map(sc => (
              <Field key={sc.id} label={sc.name}>
                <select className={inputCls} value={p.deviceNeedMap[sc.id] ?? 'none'} onChange={e => setNeed(sc.id, e.target.value as DeviceNeed)}>
                  <option value="none">None</option><option value="laptop">Laptop / desktop</option><option value="phone">Phone / tablet</option><option value="both">Both</option>
                </select>
              </Field>
            ))}
          </div>
        </div>
        <Field label="Note"><input className={inputCls} value={note} onChange={e => setNote(e.target.value)} /></Field>
        <div className="flex flex-wrap gap-2">
          <Button busy={busy === 'pol-draft'} onClick={() => run('pol-draft', () => saveDevicePolicy(p, false, note || null), 'Device policy draft saved')}>Save as draft</Button>
          <Button variant="primary" busy={busy === 'pol-approve'} onClick={() => run('pol-approve', () => saveDevicePolicy(p, true, note || null), 'Device policy approved')}>Approve policy</Button>
        </div>
      </div>
    </Card>
  )
}
