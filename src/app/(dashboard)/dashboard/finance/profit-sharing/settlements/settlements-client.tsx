'use client'

import { useState } from 'react'
import { settle } from '../actions'
import { Badge, Button, Card, Empty, Field, Table, inputCls, inr, periodLabel, td, tdNum, useAction } from '../_components'

export interface SettlementsData {
  today: string
  entitlements: { id: string; memberId: string; label: string; periodStart: string; periodEnd: string; amountInr: number; pendingInr: number }[]
  valuations: { id: string; kind: 'usage' | 'transfer'; outcome: string | null; label: string; amountInr: number; pendingInr: number; confirmedAt: string | null }[]
  advances: { id: string; memberId: string | null; label: string; leftInr: number }[]
  accounts: { id: string; name: string; isDefault: boolean }[]
  linkable: { id: string; date: string; amountInr: number; code: string }[]
  history: { id: string; kind: string; amountInr: number; settledOn: string; what: string; who: string; reason: string | null }[]
}

type Target = { type: 'entitlement' | 'device'; id: string; memberId?: string; pendingInr: number; label: string; deviceKind?: string }

export default function SettlementsClient({ data }: { data: SettlementsData }) {
  const { run, busy, host } = useAction()
  const [target, setTarget] = useState<Target | null>(null)
  return (
    <div className="space-y-6">
      {host}
      <Card title="Pending profit shares" subtitle="Confirmed, not yet settled. Confirmation is not payment: every payment re-checks the cash available (D13).">
        {data.entitlements.length === 0 ? <Empty>Nothing pending.</Empty> : (
          <Table head={['Investor', 'Period', 'Share', 'Pending', '']}>
            {data.entitlements.map(e => (
              <tr key={e.id} className="border-b border-border/60">
                <td className={td}>{e.label}</td>
                <td className={td}>{periodLabel(e.periodStart, e.periodEnd)}</td>
                <td className={tdNum}>{inr(e.amountInr)}</td>
                <td className={tdNum}>{inr(e.pendingInr)}</td>
                <td className={td}><Button onClick={() => setTarget({ type: 'entitlement', id: e.id, memberId: e.memberId, pendingInr: e.pendingInr, label: `${e.label} · ${periodLabel(e.periodStart, e.periodEnd)}` })}>Settle…</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Device values owed" subtitle="Confirmed valuations. A usage cost was already counted when confirmed; paying it is not counted again (D14). Never on a payslip.">
        {data.valuations.length === 0 ? <Empty>Nothing owed.</Empty> : (
          <Table head={['Device', 'Kind', 'Outcome', 'Value', 'Pending', '']}>
            {data.valuations.map(v => (
              <tr key={v.id} className="border-b border-border/60">
                <td className={td}>{v.label}</td>
                <td className={td}>{v.kind === 'usage' ? 'Usage' : 'Transfer'}</td>
                <td className={td}>{v.outcome ?? '—'}</td>
                <td className={tdNum}>{inr(v.amountInr)}</td>
                <td className={tdNum}>{inr(v.pendingInr)}</td>
                <td className={td}><Button onClick={() => setTarget({ type: 'device', id: v.id, pendingInr: v.pendingInr, label: v.label, deviceKind: v.kind })}>Settle…</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {target && <SettleForm key={target.id} target={target} data={data} run={run} busy={busy} onDone={() => setTarget(null)} />}

      <Card title="Settlement history">
        {data.history.length === 0 ? <Empty>No settlements yet.</Empty> : (
          <Table head={['Date', 'What', 'Who', 'How', 'Amount', 'Reason']}>
            {data.history.map(h => (
              <tr key={h.id} className="border-b border-border/60">
                <td className={td}>{h.settledOn}</td>
                <td className={td}>{h.what}</td>
                <td className={td}>{h.who}</td>
                <td className={td}><Badge tone={h.kind === 'waived' ? 'muted' : 'good'}>{h.kind.replace('_', ' ')}</Badge></td>
                <td className={tdNum}>{inr(h.amountInr)}</td>
                <td className={`${td} text-xs text-muted-foreground`}>{h.reason ?? ''}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

function SettleForm({ target, data, run, busy, onDone }: {
  target: Target; data: SettlementsData; run: ReturnType<typeof useAction>['run']; busy: string | null; onDone: () => void
}) {
  const isDevice = target.type === 'device'
  const [kind, setKind] = useState<'paid' | 'reinvested' | 'waived' | 'advance_offset'>('paid')
  const [amount, setAmount] = useState(String(target.pendingInr))
  const [date, setDate] = useState(data.today)
  const [reason, setReason] = useState('')
  const [ack, setAck] = useState('')
  const [mode, setMode] = useState<'create' | 'link'>('create')
  const defaultAccount = data.accounts.find(a => a.isDefault)?.id ?? data.accounts[0]?.id ?? ''
  const [bank, setBank] = useState(defaultAccount)
  const [entry, setEntry] = useState('')
  const advances = data.advances.filter(a => a.memberId === target.memberId)
  const [reviewId, setReviewId] = useState(advances[0]?.id ?? '')
  const wantCode = isDevice ? 'opex.equipment' : 'excluded.profit_distribution'

  return (
    <Card title={`Settle — ${target.label}`} subtitle={`Pending ${inr(target.pendingInr)}`}
      actions={<Button onClick={onDone}>Close</Button>}>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="How">
          <select className={inputCls} value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
            <option value="paid">Pay (Cash Book outflow)</option>
            <option value="reinvested">Reinvest as capital{isDevice ? ' (needs an approved device agreement)' : ''}</option>
            <option value="waived">Waive (reason required)</option>
            {!isDevice && advances.length > 0 && <option value="advance_offset">Offset a reviewed advance</option>}
          </select>
        </Field>
        <Field label="Amount (₹)"><input type="number" step="0.01" min="0.01" className={inputCls} value={amount} onChange={e => setAmount(e.target.value)} /></Field>
        <Field label="Date"><input type="date" className={inputCls} value={date} onChange={e => setDate(e.target.value)} /></Field>
        {kind === 'waived' && <Field label="Reason"><input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} /></Field>}
        {kind === 'advance_offset' && (
          <Field label="Advance">
            <select className={inputCls} value={reviewId} onChange={e => setReviewId(e.target.value)}>
              {advances.map(a => <option key={a.id} value={a.id}>{inr(a.leftInr)} left</option>)}
            </select>
          </Field>
        )}
        {kind === 'paid' && (
          <>
            <Field label="Cash Book">
              <select className={inputCls} value={mode} onChange={e => setMode(e.target.value as 'create' | 'link')}>
                <option value="create">Create the outflow now</option>
                <option value="link">Link an existing outflow</option>
              </select>
            </Field>
            {mode === 'create' ? (
              <Field label="From account" hint="Description is neutral: no investor name or amount in the text">
                <select className={inputCls} value={bank} onChange={e => setBank(e.target.value)}>
                  {data.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="Existing outflow">
                <select className={inputCls} value={entry} onChange={e => setEntry(e.target.value)}>
                  <option value="">Choose…</option>
                  {data.linkable.filter(l => l.code === wantCode).map(l => <option key={l.id} value={l.id}>{l.date} · {inr(l.amountInr)}</option>)}
                </select>
              </Field>
            )}
            <Field label="Acknowledgement (only if more than cash available)" hint="Required when the payment exceeds the cash available after liabilities and the reserve">
              <input className={inputCls} value={ack} onChange={e => setAck(e.target.value)} />
            </Field>
          </>
        )}
      </div>
      <div className="mt-3">
        <Button variant="primary" busy={busy === 'settle'} onClick={async () => {
          const ok = await run('settle', () => settle({
            entitlementId: isDevice ? null : target.id, deviceValuationId: isDevice ? target.id : null,
            kind, amountInr: Number(amount), settledOn: date, reason: reason || null,
            reviewId: kind === 'advance_offset' ? reviewId : null, cashAck: ack || null,
            cash: kind === 'paid' ? { mode, bankAccountId: mode === 'create' ? bank || null : null, entryId: mode === 'link' ? entry || null : null } : null,
          }), 'Settlement recorded')
          if (ok) onDone()
        }}>Record settlement</Button>
      </div>
    </Card>
  )
}
