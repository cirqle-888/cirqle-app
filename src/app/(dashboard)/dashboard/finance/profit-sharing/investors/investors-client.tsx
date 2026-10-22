'use client'

import { useMemo, useState } from 'react'
import type { Agreement, CapitalRow, Member, SettlementRow } from '@/lib/profit-sharing/load'
import type { Review } from '@/lib/profit-sharing/types'
import {
  approveAgreement, createAgreement, createMember, decideCapital, endAgreement, recordCapital, saveReview, updateMember,
} from '../actions'
import { Badge, Button, Card, Empty, Field, STATUS_TONE, Table, inputCls, inr, periodLabel, td, tdNum, useAction } from '../_components'

export interface InvestorsData {
  today: string
  employees: { id: string; cqid: string; active: boolean }[]
  members: (Member & { capitalToday: number; pendingInr: number })[]
  capital: CapitalRow[]
  agreements: Agreement[]
  entitlements: { id: string; memberId: string; amountInr: number; pendingInr: number; periodStart: string; periodEnd: string }[]
  settlements: SettlementRow[]
  withdrawals: { id: string; date: string; amountInr: number; description: string | null; review: Review | null }[]
  advances: { id: string; memberId: string | null; amountInr: number; date: string; usedInr: number }[]
  linkableCapitalEntries: { id: string; date: string; type: string; amountInr: number; description: string | null }[]
}

const ROLES = ['founder', 'employee', 'investor'] as const
const KIND_LABEL: Record<string, string> = {
  opening_balance: 'Opening balance', investment: 'Investment', withdrawal: 'Withdrawal', reinvestment: 'Reinvested profit',
  device_contribution: 'Device capital', correction_in: 'Correction (in)', correction_out: 'Correction (out)',
}
const WITHDRAWAL_CLASSES: [string, string][] = [
  ['capital_withdrawal', 'Capital withdrawal'],
  ['advance_distribution', 'Advance profit distribution'],
  ['personal_drawing', 'Other personal drawing'],
  ['reimbursement', 'Reimbursement of a business expense (counts as an expense)'],
  ['loan_to_member', 'Loan to the person'],
  ['other', 'Other (note required)'],
]

export default function InvestorsClient({ data }: { data: InvestorsData }) {
  const { run, busy, host } = useAction()
  const label = useMemo(() => new Map(data.members.map(m => [m.id, m.label])), [data.members])
  const nameOf = (id: string | null) => (id ? label.get(id) ?? '—' : '—')

  return (
    <div className="space-y-6">
      {host}
      <MembersCard data={data} run={run} busy={busy} />
      <CapitalCard data={data} run={run} busy={busy} nameOf={nameOf} />
      <AgreementsCard data={data} run={run} busy={busy} nameOf={nameOf} />
      <StatementCard data={data} nameOf={nameOf} />
      <WithdrawalsCard data={data} run={run} busy={busy} />
    </div>
  )
}

type Run = ReturnType<typeof useAction>['run']
type Busy = string | null

function MembersCard({ data, run, busy }: { data: InvestorsData; run: Run; busy: Busy }) {
  const [kind, setKind] = useState<'employee' | 'external'>('employee')
  const [employeeId, setEmployeeId] = useState('')
  const [displayLabel, setDisplayLabel] = useState('')
  const [roles, setRoles] = useState<string[]>(['founder'])
  const [joinedOn, setJoinedOn] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ roles: string[]; exitedOn: string; notes: string; displayLabel: string }>({ roles: [], exitedOn: '', notes: '', displayLabel: '' })
  const taken = new Set(data.members.map(m => m.employeeId).filter(Boolean))

  const toggle = (list: string[], r: string) => (list.includes(r) ? list.filter(x => x !== r) : [...list, r])

  return (
    <Card title="Investors" subtitle="Founder, employee investors and external investors. Employees appear by CQID; someone can hold several roles.">
      {data.members.length === 0 ? <Empty>No investors yet. Add yourself as founder first.</Empty> : (
        <Table head={['Investor', 'Roles', 'Joined', 'Exited', 'Capital today', 'Pending share', '']}>
          {data.members.map(m => (
            <tr key={m.id} className="border-b border-border/60">
              <td className={td}>{m.label}{!m.employeeId && <span className="ml-1 text-xs text-muted-foreground">(external)</span>}</td>
              <td className={td}>
                {editing === m.id ? (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {ROLES.map(r => (
                      <label key={r} className="flex items-center gap-1">
                        <input type="checkbox" checked={edit.roles.includes(r)} onChange={() => setEdit(e => ({ ...e, roles: toggle(e.roles, r) }))} />{r}
                      </label>
                    ))}
                  </div>
                ) : m.roles.join(', ')}
              </td>
              <td className={td}>{m.joinedOn ?? m.employeeJoined ?? '—'}</td>
              <td className={td}>
                {editing === m.id
                  ? <input type="date" className={inputCls} value={edit.exitedOn} onChange={e => setEdit(x => ({ ...x, exitedOn: e.target.value }))} />
                  : m.exitedOn ?? '—'}
              </td>
              <td className={tdNum}>{inr(m.capitalToday)}</td>
              <td className={tdNum}>{inr(m.pendingInr)}</td>
              <td className={td}>
                {editing === m.id ? (
                  <div className="flex gap-1">
                    <Button variant="primary" busy={busy === `m${m.id}`} onClick={async () => {
                      const ok = await run(`m${m.id}`, () => updateMember({ id: m.id, roles: edit.roles, displayLabel: edit.displayLabel || null, exitedOn: edit.exitedOn || null, notes: edit.notes || null }), 'Investor updated')
                      if (ok) setEditing(null)
                    }}>Save</Button>
                    <Button onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                ) : (
                  <Button onClick={() => { setEditing(m.id); setEdit({ roles: m.roles, exitedOn: m.exitedOn ?? '', notes: m.notes ?? '', displayLabel: m.employeeId ? '' : m.label }) }}>Edit</Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <form className="mt-4 grid gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-5" onSubmit={async e => {
        e.preventDefault()
        const ok = await run('add-member', () => createMember({
          employeeId: kind === 'employee' ? employeeId || null : null,
          displayLabel: kind === 'external' ? displayLabel : null, roles, joinedOn: joinedOn || null, notes: null,
        }), 'Investor added')
        if (ok) { setEmployeeId(''); setDisplayLabel(''); setJoinedOn('') }
      }}>
        <Field label="Who">
          <select className={inputCls} value={kind} onChange={e => setKind(e.target.value as 'employee' | 'external')}>
            <option value="employee">An employee (by CQID)</option>
            <option value="external">An external investor</option>
          </select>
        </Field>
        {kind === 'employee' ? (
          <Field label="Employee">
            <select className={inputCls} value={employeeId} onChange={e => setEmployeeId(e.target.value)} required>
              <option value="">Choose…</option>
              {data.employees.filter(e => !taken.has(e.id)).map(e => <option key={e.id} value={e.id}>{e.cqid}{e.active ? '' : ' (inactive)'}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Label"><input className={inputCls} value={displayLabel} onChange={e => setDisplayLabel(e.target.value)} required /></Field>
        )}
        <Field label="Roles">
          <div className="flex flex-wrap gap-2 pt-2 text-xs">
            {ROLES.map(r => <label key={r} className="flex items-center gap-1"><input type="checkbox" checked={roles.includes(r)} onChange={() => setRoles(toggle(roles, r))} />{r}</label>)}
          </div>
        </Field>
        <Field label="Joined (optional)"><input type="date" className={inputCls} value={joinedOn} onChange={e => setJoinedOn(e.target.value)} /></Field>
        <div className="flex items-end"><Button type="submit" variant="primary" busy={busy === 'add-member'}>Add investor</Button></div>
      </form>
    </Card>
  )
}

function CapitalCard({ data, run, busy, nameOf }: { data: InvestorsData; run: Run; busy: Busy; nameOf: (id: string | null) => string }) {
  const [f, setF] = useState({ memberId: '', kind: 'opening_balance', amountInr: '', receivedOn: data.today, effectiveOn: data.today, cashbookEntryId: '', reason: '', notes: '' })
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))
  return (
    <Card title="Capital ledger" subtitle="Append-only. A movement counts from its effective date once approved; approved rows never change — corrections are new rows with a reason.">
      {data.capital.length === 0 ? <Empty>No capital recorded.</Empty> : (
        <Table head={['Investor', 'Movement', 'Amount', 'Received', 'Counts from', 'Weight', 'Status', '']}>
          {data.capital.map(c => (
            <tr key={c.id} className="border-b border-border/60">
              <td className={td}>{nameOf(c.memberId)}</td>
              <td className={td}>{KIND_LABEL[c.kind] ?? c.kind}{c.reason && <div className="text-xs text-muted-foreground">{c.reason}</div>}</td>
              <td className={tdNum}>{c.direction === 'out' ? '−' : ''}{inr(c.amountInr)}</td>
              <td className={td}>{c.receivedOn}</td>
              <td className={td}>{c.effectiveOn}</td>
              <td className={tdNum}>{c.weight}</td>
              <td className={td}><Badge tone={STATUS_TONE[c.status]}>{c.status.replace('_', ' ')}</Badge></td>
              <td className={td}>
                {c.status === 'pending_approval' && (
                  <div className="flex gap-1">
                    <Button variant="primary" busy={busy === `a${c.id}`} onClick={() => run(`a${c.id}`, () => decideCapital(c.id, 'approved'), 'Capital approved')}>Approve</Button>
                    <Button variant="danger" busy={busy === `r${c.id}`} onClick={() => run(`r${c.id}`, () => decideCapital(c.id, 'rejected'), 'Capital rejected')}>Reject</Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <form className="mt-4 grid gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-4" onSubmit={async e => {
        e.preventDefault()
        const ok = await run('capital', () => recordCapital({
          memberId: f.memberId, kind: f.kind as 'investment', amountInr: Number(f.amountInr), receivedOn: f.receivedOn,
          effectiveOn: f.effectiveOn, cashbookEntryId: f.cashbookEntryId || null, agreementId: null, reason: f.reason || null, notes: f.notes || null,
        }), 'Capital recorded — approve it to make it count')
        if (ok) setF(x => ({ ...x, amountInr: '', cashbookEntryId: '', reason: '', notes: '' }))
      }}>
        <Field label="Investor">
          <select className={inputCls} value={f.memberId} onChange={e => set('memberId', e.target.value)} required>
            <option value="">Choose…</option>
            {data.members.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Movement">
          <select className={inputCls} value={f.kind} onChange={e => set('kind', e.target.value)}>
            {['opening_balance', 'investment', 'withdrawal', 'correction_in', 'correction_out'].map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <Field label="Amount (₹)"><input type="number" step="0.01" min="0.01" className={inputCls} value={f.amountInr} onChange={e => set('amountInr', e.target.value)} required /></Field>
        <Field label="Cash Book entry (optional)" hint="Capital Introduced / Capital Withdrawn entries not yet linked">
          <select className={inputCls} value={f.cashbookEntryId} onChange={e => set('cashbookEntryId', e.target.value)}>
            <option value="">None</option>
            {data.linkableCapitalEntries.map(x => <option key={x.id} value={x.id}>{x.date} · {x.type} · {inr(x.amountInr)}</option>)}
          </select>
        </Field>
        <Field label="Received on"><input type="date" className={inputCls} value={f.receivedOn} onChange={e => set('receivedOn', e.target.value)} required /></Field>
        <Field label="Counts from" hint="Not before it was received; not inside a confirmed period"><input type="date" className={inputCls} value={f.effectiveOn} onChange={e => set('effectiveOn', e.target.value)} required /></Field>
        <Field label="Reason (corrections)"><input className={inputCls} value={f.reason} onChange={e => set('reason', e.target.value)} /></Field>
        <div className="flex items-end"><Button type="submit" variant="primary" busy={busy === 'capital'}>Record movement</Button></div>
      </form>
    </Card>
  )
}

function AgreementsCard({ data, run, busy, nameOf }: { data: InvestorsData; run: Run; busy: Busy; nameOf: (id: string | null) => string }) {
  const empty = {
    memberId: '', kind: 'capital_investment', title: '', terms: '', repaymentTerms: '', survive: '', weight: '', fixed: '',
    buyback: '', effectiveFrom: data.today, documentUrl: '', review: '',
  }
  const [f, setF] = useState(empty)
  const [ending, setEnding] = useState<{ id: string; date: string } | null>(null)
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))
  const isDevice = f.kind === 'device_investment'
  return (
    <Card title="Agreements" subtitle="Capital and device-investment terms. Legally significant: every term must be recorded before approval, and professional review is recommended.">
      {data.agreements.length === 0 ? <Empty>No agreements recorded.</Empty> : (
        <Table head={['Investor', 'Agreement', 'Terms', 'From', 'Status', '']}>
          {data.agreements.map(a => (
            <tr key={a.id} className="border-b border-border/60">
              <td className={td}>{nameOf(a.memberId)}</td>
              <td className={td}>{a.title}<div className="text-xs text-muted-foreground">{a.kind === 'device_investment' ? 'Device investment' : 'Capital investment'}</div></td>
              <td className={`${td} text-xs text-muted-foreground`}>
                <div>Repayment on exit: {a.repaymentTerms ?? '—'}</div>
                <div>Entitlements survive exit: {a.entitlementsSurviveExit == null ? '—' : a.entitlementsSurviveExit ? 'yes' : 'no'}</div>
                {a.kind === 'device_investment' && <>
                  <div>Weight vs cash capital: {a.deviceCapitalWeight ?? '—'}</div>
                  <div>Stays fixed: {a.deviceCapitalFixed == null ? '—' : a.deviceCapitalFixed ? 'yes' : 'no'}</div>
                  <div>Buy-back: {a.buybackTerms ?? '—'}</div>
                </>}
                {a.professionalReviewNote && <div>Professional review: {a.professionalReviewNote}</div>}
              </td>
              <td className={td}>{a.effectiveFrom}{a.effectiveTo ? ` → ${a.effectiveTo}` : ''}</td>
              <td className={td}><Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge></td>
              <td className={td}>
                {a.status === 'draft' && <Button variant="primary" busy={busy === `ag${a.id}`} onClick={() => run(`ag${a.id}`, () => approveAgreement(a.id), 'Agreement approved')}>Approve</Button>}
                {a.status === 'approved' && (ending?.id === a.id ? (
                  <div className="flex gap-1">
                    <input type="date" className={inputCls} value={ending.date} onChange={e => setEnding({ id: a.id, date: e.target.value })} />
                    <Button busy={busy === `end${a.id}`} onClick={async () => { if (await run(`end${a.id}`, () => endAgreement(a.id, ending.date), 'Agreement ended')) setEnding(null) }}>End</Button>
                  </div>
                ) : <Button onClick={() => setEnding({ id: a.id, date: data.today })}>End…</Button>)}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <form className="mt-4 grid gap-3 rounded-lg border border-dashed border-border p-3 md:grid-cols-3" onSubmit={async e => {
        e.preventDefault()
        const ok = await run('agreement', () => createAgreement({
          memberId: f.memberId, kind: f.kind as 'capital_investment', title: f.title, terms: f.terms || null,
          repaymentTerms: f.repaymentTerms || null, entitlementsSurviveExit: f.survive === '' ? null : f.survive === 'yes',
          deviceCapitalWeight: isDevice && f.weight ? Number(f.weight) : null, deviceCapitalFixed: isDevice && f.fixed ? f.fixed === 'yes' : null,
          buybackTerms: isDevice ? f.buyback || null : null, effectiveFrom: f.effectiveFrom, effectiveTo: null,
          documentUrl: f.documentUrl || null, professionalReviewNote: f.review || null,
        }), 'Agreement saved as a draft')
        if (ok) setF(empty)
      }}>
        <Field label="Investor">
          <select className={inputCls} value={f.memberId} onChange={e => set('memberId', e.target.value)} required>
            <option value="">Choose…</option>
            {data.members.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Kind">
          <select className={inputCls} value={f.kind} onChange={e => set('kind', e.target.value)}>
            <option value="capital_investment">Capital investment</option>
            <option value="device_investment">Device investment (D10)</option>
          </select>
        </Field>
        <Field label="Title"><input className={inputCls} value={f.title} onChange={e => set('title', e.target.value)} required /></Field>
        <Field label="Repayment on exit (D12)" hint="No default is assumed"><input className={inputCls} value={f.repaymentTerms} onChange={e => set('repaymentTerms', e.target.value)} /></Field>
        <Field label="Earned entitlements survive exit? (D12)">
          <select className={inputCls} value={f.survive} onChange={e => set('survive', e.target.value)}>
            <option value="">Not decided</option><option value="yes">Yes</option><option value="no">No</option>
          </select>
        </Field>
        <Field label="Effective from"><input type="date" className={inputCls} value={f.effectiveFrom} onChange={e => set('effectiveFrom', e.target.value)} required /></Field>
        {isDevice && <>
          <Field label="Weight vs cash capital (0–1)"><input type="number" step="0.0001" min="0.0001" max="1" className={inputCls} value={f.weight} onChange={e => set('weight', e.target.value)} /></Field>
          <Field label="Device capital stays fixed?">
            <select className={inputCls} value={f.fixed} onChange={e => set('fixed', e.target.value)}>
              <option value="">Not decided</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </Field>
          <Field label="Buy-back / repayment terms"><input className={inputCls} value={f.buyback} onChange={e => set('buyback', e.target.value)} /></Field>
        </>}
        <Field label="Other terms"><input className={inputCls} value={f.terms} onChange={e => set('terms', e.target.value)} /></Field>
        <Field label="Signed document (link)"><input className={inputCls} value={f.documentUrl} onChange={e => set('documentUrl', e.target.value)} /></Field>
        <Field label="Professional review note"><input className={inputCls} value={f.review} onChange={e => set('review', e.target.value)} /></Field>
        <div className="flex items-end"><Button type="submit" variant="primary" busy={busy === 'agreement'}>Save draft agreement</Button></div>
      </form>
    </Card>
  )
}

function StatementCard({ data, nameOf }: { data: InvestorsData; nameOf: (id: string | null) => string }) {
  if (!data.members.length) return null
  return (
    <Card title="Statements" subtitle="Per investor: capital, shares by period, what was settled, and advances still to offset.">
      <div className="space-y-2">
        {data.members.map(m => {
          const ents = data.entitlements.filter(e => e.memberId === m.id)
          const advances = data.advances.filter(a => a.memberId === m.id)
          return (
            <details key={m.id} className="rounded-lg border border-border">
              <summary className="flex cursor-pointer list-none justify-between px-3 py-2 text-sm">
                <span>{nameOf(m.id)}</span>
                <span className="tabular-nums text-muted-foreground">capital {inr(m.capitalToday)} · pending {inr(m.pendingInr)}</span>
              </summary>
              <div className="space-y-3 border-t border-border p-3 text-sm">
                {ents.length === 0 ? <p className="text-muted-foreground">No confirmed shares yet.</p> : (
                  <Table head={['Period', 'Share', 'Pending', 'Settled']}>
                    {ents.map(e => (
                      <tr key={e.id} className="border-b border-border/60">
                        <td className={td}>{periodLabel(e.periodStart, e.periodEnd)}</td>
                        <td className={tdNum}>{inr(e.amountInr)}</td>
                        <td className={tdNum}>{inr(e.pendingInr)}</td>
                        <td className={`${td} text-xs text-muted-foreground`}>
                          {data.settlements.filter(s => s.entitlementId === e.id).map(s => `${s.kind.replace('_', ' ')} ${inr(s.amountInr)} on ${s.settledOn}`).join(' · ') || '—'}
                        </td>
                      </tr>
                    ))}
                  </Table>
                )}
                {advances.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Advances to offset: {advances.map(a => `${inr(a.amountInr - a.usedInr)} left of ${inr(a.amountInr)} (${a.date})`).join(' · ')}
                  </p>
                )}
              </div>
            </details>
          )
        })}
      </div>
    </Card>
  )
}

function WithdrawalsCard({ data, run, busy }: { data: InvestorsData; run: Run; busy: Busy }) {
  const [open, setOpen] = useState<string | null>(null)
  const [f, setF] = useState({ classification: 'personal_drawing', memberId: '', note: '' })
  const pending = data.withdrawals.filter(w => !w.review).length
  return (
    <div id="withdrawals">
      <Card title="Historical Personal Withdrawals" subtitle={`Reviewed one by one — never classified automatically. ${pending} still to review.`}>
        {data.withdrawals.length === 0 ? <Empty>No Personal Withdrawals in the Cash Book.</Empty> : (
          <Table head={['Date', 'Amount', 'Cash Book note', 'Classification', '']}>
            {data.withdrawals.map(w => (
              <tr key={w.id} className="border-b border-border/60">
                <td className={td}>{w.date}</td>
                <td className={tdNum}>{inr(w.amountInr)}</td>
                <td className={`${td} max-w-[240px] truncate text-xs text-muted-foreground`}>{w.description ?? '—'}</td>
                <td className={td}>
                  {open === w.id ? (
                    <div className="grid gap-2 md:grid-cols-3">
                      <select className={inputCls} value={f.classification} onChange={e => setF(x => ({ ...x, classification: e.target.value }))}>
                        {WITHDRAWAL_CLASSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                      <select className={inputCls} value={f.memberId} onChange={e => setF(x => ({ ...x, memberId: e.target.value }))}>
                        <option value="">Whose? (needed for capital / advance)</option>
                        {data.members.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                      <input className={inputCls} placeholder="Note" value={f.note} onChange={e => setF(x => ({ ...x, note: e.target.value }))} />
                    </div>
                  ) : w.review ? (
                    <span className="text-xs">{WITHDRAWAL_CLASSES.find(c => c[0] === w.review!.classification)?.[1] ?? w.review.classification}</span>
                  ) : <Badge tone="warn">to review</Badge>}
                </td>
                <td className={td}>
                  {open === w.id ? (
                    <div className="flex gap-1">
                      <Button variant="primary" busy={busy === `w${w.id}`} onClick={async () => {
                        const ok = await run(`w${w.id}`, () => saveReview({
                          sourceTable: 'cashbook_entries', sourceId: w.id, category: 'personal_withdrawal', classification: f.classification,
                          memberId: f.memberId || null, amountInr: w.amountInr, sourceDate: w.date, detail: null, note: f.note || null,
                        }), 'Withdrawal classified')
                        if (ok) setOpen(null)
                      }}>Save</Button>
                      <Button onClick={() => setOpen(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button onClick={() => { setOpen(w.id); setF({ classification: w.review?.classification ?? 'personal_drawing', memberId: w.review?.memberId ?? '', note: '' }) }}>
                      {w.review ? 'Change' : 'Review'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}
