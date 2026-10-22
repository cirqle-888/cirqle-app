'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Ban, CheckCircle2 } from 'lucide-react'
import type { RunComputation } from '@/lib/profit-sharing/engine'
import type { RunRow } from '@/lib/profit-sharing/load'
import type { ReviewItem } from '@/lib/profit-sharing/types'
import {
  calculateRun, confirmRun, deleteDraftRun, markReviewed, saveReview, setOpeningLoss, voidRun,
} from '../../actions'
import { Badge, Button, Card, Empty, Field, STATUS_TONE, Stat, Table, Workings, inputCls, inr, pct, periodLabel, td, tdNum, useAction } from '../../_components'

export interface ReviewSupport {
  cqid: Record<string, string>
  payslips: { id: string; employeeId: string; label: string }[]
  credits: { id: string; employeeId: string; label: string }[]
  invoices: Record<string, { number: string | null; totalInr: number; taxInr: number; carriedInr: number }>
}

export default function RunDetailClient({ run, stored, live, liveError, isFirst, members, support }: {
  run: Omit<RunRow, 'summary'> & { summary?: undefined }
  stored: RunComputation | null
  live: RunComputation | null
  liveError: string | null
  isFirst: boolean
  members: { id: string; label: string }[]
  support: ReviewSupport
}) {
  const { run: act, busy, host } = useAction()
  const router = useRouter()
  const [ack, setAck] = useState('')
  const [voidReason, setVoidReason] = useState('')
  const [openingLoss, setOpeningLossValue] = useState(run.openingLossInr != null ? String(run.openingLossInr) : '')
  const confirmed = run.status === 'confirmed'
  const final = confirmed || run.status === 'void'
  // A confirmed period shows its frozen figures; an open one shows the live computation.
  const c = confirmed ? stored : live
  const stale = !final && !!live && !!run.fingerprint && live.fingerprint !== run.fingerprint
  const drift = confirmed && !!live && !!stored && live.fingerprint !== run.fingerprint
  const blocks = live?.gates.filter(g => g.level === 'block') ?? []
  const warns = (c ?? live)?.gates.filter(g => g.level === 'warn') ?? []
  const label = new Map(members.map(m => [m.id, m.label]))

  return (
    <div className="space-y-6">
      {host}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/dashboard/finance/profit-sharing/periods" className="text-xs text-muted-foreground hover:underline">← All periods</Link>
          <h2 className="mt-1 flex items-center gap-2 text-xl font-semibold">
            {periodLabel(run.periodStart, run.periodEnd)} <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
          </h2>
          <p className="text-xs text-muted-foreground">
            {run.periodStart} to {run.periodEnd}
            {run.calculatedAt && ` · calculated ${run.calculatedAt.slice(0, 16).replace('T', ' ')}`}
            {run.reviewedAt && ` · reviewed ${run.reviewedAt.slice(0, 16).replace('T', ' ')}`}
            {run.confirmedAt && ` · confirmed ${run.confirmedAt.slice(0, 16).replace('T', ' ')}`}
          </p>
        </div>
        {!final && (
          <div className="flex flex-wrap gap-2">
            <Button busy={busy === 'calc'} onClick={() => act('calc', () => calculateRun(run.id), 'Calculated')}>{run.status === 'draft' ? 'Calculate' : 'Recalculate'}</Button>
            {run.status === 'calculated' && (
              <Button variant="primary" busy={busy === 'rev'} disabled={stale} onClick={() => act('rev', () => markReviewed(run.id), 'Marked reviewed')}>Mark reviewed</Button>
            )}
            <Button variant="danger" busy={busy === 'del'} onClick={async () => {
              if (await act('del', () => deleteDraftRun(run.id), 'Period deleted')) router.push('/dashboard/finance/profit-sharing/periods')
            }}>Delete</Button>
          </div>
        )}
      </div>

      {liveError && <Banner tone="bad">Could not read the books: {liveError}</Banner>}
      {stale && <Banner tone="warn">The books changed since this period was calculated. Recalculate before reviewing or confirming.</Banner>}
      {drift && live && stored && (
        <Banner tone="warn">
          The books under this confirmed period have changed since it was confirmed. The confirmed figures stand; record a
          documented adjustment in a later period. Live cash profit now: {inr(live.profit.profitInr)} (confirmed {inr(stored.profit.profitInr)}).
        </Banner>
      )}
      {run.status === 'void' && <Banner tone="bad">Voided: {run.voidReason}</Banner>}

      {isFirst && !final && (
        <Card title="Opening accumulated loss (D7)" subtitle="The first period needs this before it can be confirmed. It is entered by you — history is never used to set it.">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Opening accumulated loss (₹)"><input type="number" step="0.01" min="0" className={inputCls} value={openingLoss} onChange={e => setOpeningLossValue(e.target.value)} /></Field>
            <Button variant="primary" busy={busy === 'ol'} disabled={openingLoss === ''} onClick={() => act('ol', () => setOpeningLoss(run.id, Number(openingLoss)), 'Opening loss saved — recalculate')}>Save</Button>
            {run.openingLossEntered && <span className="text-xs text-muted-foreground">Recorded: {inr(run.openingLossInr)}</span>}
          </div>
        </Card>
      )}

      {!final && live && (
        <Card title="Before confirming" subtitle="Blocking checks must be resolved. Warnings are shown but do not block.">
          {blocks.length === 0 && warns.length === 0 ? (
            <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Every check passes.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {blocks.map(g => <li key={g.key} className="flex gap-2"><Ban className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /><span>{g.message}{g.count ? ` (${g.count})` : ''}{g.amountInr != null ? ` — ${inr(g.amountInr)}` : ''}</span></li>)}
              {warns.map(g => <li key={g.key} className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><span>{g.message}{g.count ? ` (${g.count})` : ''}{g.amountInr != null ? ` — ${inr(g.amountInr)}` : ''}</span></li>)}
            </ul>
          )}
          {run.status === 'reviewed' && (
            <div className="mt-4 space-y-2 border-t border-border pt-4">
              {live.freeCash.capitalShareExceedsCash && (
                <Field label="Written acknowledgement (D13)" hint="The Capital Share is more than the cash available. Confirmation is not payment; each payment re-checks cash.">
                  <textarea className={inputCls} rows={2} value={ack} onChange={e => setAck(e.target.value)} />
                </Field>
              )}
              <Button variant="primary" busy={busy === 'conf'} disabled={blocks.length > 0 || stale}
                onClick={() => act('conf', () => confirmRun(run.id, ack || null), 'Period confirmed — its figures are now frozen')}>
                Confirm period
              </Button>
            </div>
          )}
        </Card>
      )}

      {confirmed && (
        <Card title="Void this period" subtitle="Only the latest confirmed period, only while nothing has been settled, and only with a reason.">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Reason"><input className={inputCls} value={voidReason} onChange={e => setVoidReason(e.target.value)} /></Field>
            <Button variant="danger" busy={busy === 'void'} disabled={!voidReason.trim()} onClick={() => act('void', () => voidRun(run.id, voidReason), 'Period voided')}>Void</Button>
          </div>
        </Card>
      )}

      {!c ? (
        <Card><Empty>Calculate the period to see its figures.</Empty></Card>
      ) : (
        <Figures c={c} label={label} />
      )}

      {!final && live && live.reviewItems.length > 0 && (
        <ReviewQueue items={live.reviewItems} members={members} support={support} act={act} busy={busy} />
      )}
    </div>
  )
}

function Banner({ tone, children }: { tone: 'warn' | 'bad'; children: React.ReactNode }) {
  const cls = tone === 'bad' ? 'border-red-500/40 bg-red-500/5' : 'border-amber-500/40 bg-amber-500/5'
  return <div className={`rounded-xl border p-3 text-sm ${cls}`}>{children}</div>
}

function Figures({ c, label }: { c: RunComputation; label: Map<string, string> }) {
  const p = c.profit
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cash profit" value={inr(p.profitInr)} tone={p.profitInr < 0 ? 'bad' : undefined} />
        <Stat label="Eligible profit" value={inr(c.loss.eligibleProfitInr)} hint={`after ${inr(c.loss.lossOffsetInr)} of losses absorbed`} />
        <Stat label="Capital Share" value={inr(c.distribution.capitalShareInr)} />
        <Stat label="Business Reserve" value={inr(c.distribution.reserveInr)} hint="An earmark; no cash moves" />
      </div>

      <Card title="How the profit is worked out" subtitle="Cirqle’s own money collected, minus own operating payments, minus pay earned. Open each line for its workings.">
        <div className="space-y-2">
          <Workings label="Own revenue collected" value={inr(p.ownRevenueInr)}>
            The own-revenue share of client receipts applied to invoices (pass-through first, then tax, then Cirqle’s fee — D2),
            on the later of the receipt and allocation dates, plus reviewed receipts with no invoice. Refunds (reversals) come off on their own date.
            Client money not yet applied to an invoice is held, not revenue (D3).
          </Workings>
          <Workings label="Own operating payments" value={`− ${inr(p.operatingPaymentsInr)}`}>
            Cash Book cost and expense payments that are Cirqle’s own: excludes money paid on clients’ behalf, unassigned ad funding (prepaid),
            salary payments (they settle payroll), and anything linked to a device usage settlement.
          </Workings>
          <Workings label="Remuneration earned" value={`− ${inr(p.remunerationInr)}`}>
            Payroll gross for the period’s months: base + commission + bonus + adjustment + ownership, from the components — counted once, when earned
            ({inr(c.payroll.grossEarnedInr)}), plus advances converted to pay that were classified as additional pay ({inr(c.payroll.conversionPayInr)}).
          </Workings>
          {p.extraPayInr !== 0 && <Workings label="Pay outside payroll (reviewed)" value={`− ${inr(p.extraPayInr)}`}>Salary payments with no payslip that you classified as extra pay.</Workings>}
          {p.deviceCostsInr !== 0 && <Workings label="Device usage costs confirmed in the period" value={`− ${inr(p.deviceCostsInr)}`}>Recognised when each valuation was confirmed (D14); the later payment is not counted again.</Workings>}
          {(p.passthroughWriteoffsInr !== 0 || p.adWriteoffsInr !== 0) && (
            <Workings label="Written off" value={`− ${inr(p.passthroughWriteoffsInr + p.adWriteoffsInr)}`}>
              Pass-through costs on invoices written off as bad debt ({inr(p.passthroughWriteoffsInr)}) and unassigned ad funding written off by review ({inr(p.adWriteoffsInr)}).
            </Workings>
          )}
          <Workings label={<b>Cash profit</b>} value={<b>{inr(p.profitInr)}</b>}>The figure losses, the pool and the Capital Share are worked out from.</Workings>
        </div>
      </Card>

      <Card title="Losses and distribution" subtitle="Losses are absorbed first. The pool is the distribution % of eligible profit; Capital Share and Reserve split the pool.">
        <div className="space-y-2">
          <Workings label="Opening accumulated loss" value={inr(c.loss.openingLossInr)}>For the first period, the figure you entered (D7). Afterwards, the previous confirmed period’s closing loss.</Workings>
          <Workings label="Loss absorbed" value={`− ${inr(c.loss.lossOffsetInr)}`}>min(opening loss, this period’s profit).</Workings>
          <Workings label="Closing accumulated loss" value={inr(c.loss.closingLossInr)}>Opening − absorbed + this period’s loss, if any.</Workings>
          <Workings label="Eligible profit" value={inr(c.distribution.eligibleProfitInr)}>Profit after losses are absorbed.</Workings>
          <Workings label="Distribution pool" value={inr(c.distribution.poolInr)}>Eligible profit × distribution %.</Workings>
          <Workings label="Capital Share" value={inr(c.distribution.capitalShareInr)}>Pool × Capital Share %. Split by capital-days below.</Workings>
          <Workings label="Business Reserve" value={inr(c.distribution.reserveInr)}>Pool − Capital Share. An earmark of retained profit (D9).</Workings>
          <Workings label="Retained outside the pool" value={inr(c.distribution.retainedOutsideInr)}>Eligible profit − pool.</Workings>
          <Workings label="Total retained in the business" value={inr(c.distribution.totalRetainedInr + c.capital.unallocatedInr)}>
            Reserve + retained outside the pool{c.capital.unallocatedInr > 0 ? ` + ${inr(c.capital.unallocatedInr)} of Capital Share nobody held capital for` : ''}.
          </Workings>
        </div>
      </Card>

      <Card title="Capital Share by capital-days" subtitle="Each investor’s approved capital × the days it counted in the period, as a share of everyone’s.">
        {c.capital.entitlements.length === 0 ? <Empty>No eligible capital in this period.</Empty> : (
          <Table head={['Investor', 'Capital at start', 'Capital at end', 'Capital-days', 'Share', 'Amount']}>
            {c.capital.entitlements.map(e => (
              <tr key={e.memberId} className="border-b border-border/60">
                <td className={td}>{label.get(e.memberId) ?? '—'}</td>
                <td className={tdNum}>{inr(e.openingBalanceInr)}</td>
                <td className={tdNum}>{inr(e.closingBalanceInr)}</td>
                <td className={tdNum}>{e.capitalDays.toLocaleString('en-IN')}</td>
                <td className={tdNum}>{pct(e.share, 3)}</td>
                <td className={tdNum}>{inr(e.amountInr)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Cash bridge" subtitle="Every Cash Book entry in the period lands in exactly one line, so opening + lines = closing. This proves the arithmetic, not the bank balance.">
        <Table head={['', 'Entries', 'Amount']}>
          <tr className="border-b border-border/60"><td className={td}>Opening cash (account opening balances + entries before the period)</td><td className={tdNum} /><td className={tdNum}>{inr(c.cash.openingInr)}</td></tr>
          {c.cash.byBucket.map(b => (
            <tr key={b.bucket} className="border-b border-border/60"><td className={td}>{b.label}</td><td className={tdNum}>{b.count}</td><td className={tdNum}>{inr(b.amountInr)}</td></tr>
          ))}
          <tr className="font-semibold"><td className={td}>Closing cash</td><td className={tdNum} /><td className={tdNum}>{inr(c.cash.closingInr)}</td></tr>
          {c.cash.bridgeDifferenceInr !== 0 && <tr className="text-red-600"><td className={td}>Difference</td><td className={tdNum} /><td className={tdNum}>{inr(c.cash.bridgeDifferenceInr)}</td></tr>}
        </Table>
      </Card>

      <Card title="Liabilities and cash available" subtitle="The reserve earmark is deducted once. Money owed to Cirqle is not cash and is not added.">
        <div className="space-y-2">
          <Workings label="Closing cash" value={inr(c.freeCash.closingCashInr)}>Cash Book balance at the period end, including account opening balances.</Workings>
          <Workings label="Unpaid payroll" value={`− ${inr(c.freeCash.payrollLiabilityInr)}`}>Net pay − salary paid, across every payslip up to the period end.</Workings>
          <Workings label="Client funds held" value={`− ${inr(c.freeCash.clientFundsHeldInr)}`}>Client receipts not yet applied to an invoice’s own parts (D3).</Workings>
          <Workings label="Pending shares from earlier periods" value={`− ${inr(c.freeCash.pendingEntitlementsInr)}`}>Confirmed, not yet paid, reinvested or waived.</Workings>
          <Workings label="Device settlements owed" value={`− ${inr(c.freeCash.unpaidDeviceInr)}`}>Confirmed device values not yet settled.</Workings>
          <Workings label="Free cash" value={inr(c.freeCash.freeCashInr)}>Closing cash − the liabilities above. GST is not deducted while D1 is open.</Workings>
          <Workings label="Business Reserve earmark" value={`− ${inr(c.freeCash.reserveBalanceInr)}`}>The reserve balance including this period’s allocation.</Workings>
          <Workings label={<b>Cash available for payment</b>} value={<b>{inr(c.freeCash.cashAvailableInr)}</b>}>What could actually be paid out now.</Workings>
          <p className="pt-1 text-xs text-muted-foreground">
            Also: paid on clients’ behalf, not yet recovered {inr(c.balances.passthroughReceivableInr)} · ad funding not yet assigned {inr(c.balances.adPrepaidInr)}
            {c.balances.taxCollectedInr ? ` · tax collected ${inr(c.balances.taxCollectedInr)}` : ''}
          </p>
        </div>
      </Card>

      <Card title="Payroll in the period" subtitle="Gross from components. Stored net salary is shown only to flag disagreement.">
        {c.payroll.rows.length === 0 ? <Empty>No payslips in the period.</Empty> : (
          <Table head={['Month', 'Gross earned', 'Net payable', 'Paid', 'Stored net differs']}>
            {c.payroll.rows.map(r => (
              <tr key={r.id} className="border-b border-border/60">
                <td className={td}>{r.month.slice(0, 7)}</td>
                <td className={tdNum}>{inr(r.gross)}</td>
                <td className={tdNum}>{inr(r.net)}</td>
                <td className={tdNum}>{inr(r.paid)}</td>
                <td className={td}>{r.storedNetDiffers ? <Badge tone="warn">yes</Badge> : ''}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

const OPTIONS: Record<string, [string, string][]> = {
  personal_withdrawal: [['capital_withdrawal', 'Capital withdrawal'], ['advance_distribution', 'Advance profit distribution'], ['personal_drawing', 'Other personal drawing'], ['reimbursement', 'Reimbursement (an expense)'], ['loan_to_member', 'Loan to the person'], ['other', 'Other']],
  unidentified_receipt: [['own_revenue', 'Cirqle revenue with no invoice'], ['client_funds', 'Client money (held)'], ['capital', 'Capital'], ['loan', 'Loan'], ['other', 'Other non-operating']],
  chargeback: [['reduce_own_revenue', 'Refund of Cirqle revenue'], ['refund_client_funds', 'Return of client money'], ['other', 'Other']],
  salary_without_payroll: [['payroll_settlement', 'Pays a payslip'], ['extra_pay', 'Extra pay outside payroll'], ['advance', 'Really an advance']],
  credit_conversion: [['additional_pay', 'Additional pay'], ['records_deduction', 'Records a payroll deduction (not counted)']],
  unassigned_ad_funding: [['write_off', 'Write off as an expense']],
  advance_deduction: [['linked', 'Linked to advance(s)']],
  invoice_split: [['split', 'Recorded split']],
}

const CATEGORY_LABEL: Record<string, string> = {
  personal_withdrawal: 'Personal Withdrawal', unidentified_receipt: 'Receipt with no client or invoice', chargeback: 'Money out of revenue',
  salary_without_payroll: 'Salary with no payslip', advance_deduction: 'Advance deducted in payroll', credit_conversion: 'Advance converted to salary',
  invoice_split: 'Invoice split', unassigned_ad_funding: 'Unassigned ad funding',
}

function ReviewQueue({ items, members, support, act, busy }: {
  items: ReviewItem[]; members: { id: string; label: string }[]; support: ReviewSupport
  act: ReturnType<typeof useAction>['run']; busy: string | null
}) {
  return (
    <Card title={`Review queue (${items.length})`} subtitle="Classify each item. The source records are never edited; unassigned ad funding only blocks once it is older than the threshold.">
      <div className="space-y-3">
        {items.map(i => <ReviewRow key={`${i.sourceTable}:${i.sourceId}`} item={i} members={members} support={support} act={act} busy={busy} />)}
      </div>
    </Card>
  )
}

function ReviewRow({ item, members, support, act, busy }: {
  item: ReviewItem; members: { id: string; label: string }[]; support: ReviewSupport
  act: ReturnType<typeof useAction>['run']; busy: string | null
}) {
  const options = OPTIONS[item.category] ?? []
  const [classification, setClassification] = useState(options[0]?.[0] ?? '')
  const [memberId, setMemberId] = useState('')
  const [note, setNote] = useState('')
  const [payrollId, setPayrollId] = useState('')
  const [creditIds, setCreditIds] = useState<string[]>([])
  const inv = support.invoices[item.sourceId]
  const [split, setSplit] = useState({ ownInr: '', passInr: '', taxInr: inv ? String(inv.taxInr || '') : '' })
  const employeeId = item.context?.employeeId as string | undefined
  const key = `rv:${item.sourceTable}:${item.sourceId}`

  const save = () => act(key, () => saveReview({
    sourceTable: item.sourceTable, sourceId: item.sourceId, category: item.category, classification,
    memberId: memberId || null, amountInr: item.amountInr, sourceDate: item.date,
    detail: item.category === 'invoice_split' ? { ownInr: Number(split.ownInr || 0), passInr: Number(split.passInr || 0), taxInr: Number(split.taxInr || 0) }
      : item.category === 'salary_without_payroll' && classification === 'payroll_settlement' ? { payrollId }
        : item.category === 'advance_deduction' ? { creditIds } : null,
    note: note || null,
  }), 'Classified')

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{CATEGORY_LABEL[item.category]}{inv?.number ? ` · ${inv.number}` : ''}</span>
        <span className="tabular-nums">{inr(item.amountInr)} · {item.date}{employeeId ? ` · ${support.cqid[employeeId] ?? ''}` : ''}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{item.reason}</p>
      <div className="mt-2 grid gap-2 md:grid-cols-4">
        {item.category === 'invoice_split' ? (
          <>
            <input className={inputCls} type="number" step="0.01" placeholder="Pass-through ₹" value={split.passInr} onChange={e => setSplit(s => ({ ...s, passInr: e.target.value }))} />
            <input className={inputCls} type="number" step="0.01" placeholder="Tax ₹" value={split.taxInr} onChange={e => setSplit(s => ({ ...s, taxInr: e.target.value }))} />
            <input className={inputCls} type="number" step="0.01" placeholder="Cirqle’s own ₹" value={split.ownInr} onChange={e => setSplit(s => ({ ...s, ownInr: e.target.value }))} />
          </>
        ) : item.category === 'advance_deduction' ? (
          <div className="md:col-span-3 flex flex-wrap gap-3 text-xs">
            {support.credits.filter(c => c.employeeId === employeeId).map(c => (
              <label key={c.id} className="flex items-center gap-1">
                <input type="checkbox" checked={creditIds.includes(c.id)} onChange={() => setCreditIds(ids => ids.includes(c.id) ? ids.filter(x => x !== c.id) : [...ids, c.id])} />
                Advance {c.label}
              </label>
            ))}
            {!support.credits.some(c => c.employeeId === employeeId) && <span className="text-muted-foreground">No advances for this employee in the credit ledger.</span>}
          </div>
        ) : (
          <select className={inputCls} value={classification} onChange={e => setClassification(e.target.value)}>
            {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        )}
        {item.category === 'personal_withdrawal' && ['capital_withdrawal', 'advance_distribution'].includes(classification) && (
          <select className={inputCls} value={memberId} onChange={e => setMemberId(e.target.value)}>
            <option value="">Whose?</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
        {item.category === 'salary_without_payroll' && classification === 'payroll_settlement' && (
          <select className={inputCls} value={payrollId} onChange={e => setPayrollId(e.target.value)}>
            <option value="">Which payslip?</option>
            {support.payslips.filter(p => p.employeeId === employeeId).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        )}
        <input className={inputCls} placeholder="Note" value={note} onChange={e => setNote(e.target.value)} />
        <div><Button variant="primary" busy={busy === key} onClick={save}>Save</Button></div>
      </div>
      {item.category === 'unassigned_ad_funding' && (
        <p className="mt-1 text-[11px] text-muted-foreground">Or share it to a client or company wallet in Advertising — then it is pass-through or Cirqle’s own marketing.</p>
      )}
    </div>
  )
}
