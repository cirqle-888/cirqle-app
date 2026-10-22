import Link from 'next/link'
import { CheckCircle2, Circle, AlertTriangle } from 'lucide-react'
import { round2 } from '@/lib/calculations/currency'
import {
  approvedDevicePolicy, balanceOnToday, loadModuleState, pendingByEntitlement, pendingByValuation, reserveBalance,
} from './_data'
import { requireProfitSharingPage } from './_page'
import { NotInstalled } from './_not-installed'
import { Badge, Card, Stat, STATUS_TONE, Table, inr, periodLabel, td, tdNum } from './_components'

export const dynamic = 'force-dynamic'

export default async function ProfitSharingOverview() {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />

  const state = await loadModuleState(admin)
  const confirmed = state.runs.filter(r => r.status === 'confirmed')
  const latest = confirmed.at(-1) ?? null
  const reserve = reserveBalance(state.reserve)
  const pendingEnt = round2([...pendingByEntitlement(state.entitlements, state.settlements, state.runs).values()].reduce((s, v) => s + v, 0))
  const pendingDev = round2([...pendingByValuation(state.valuations, state.settlements).values()].reduce((s, v) => s + v, 0))
  const capitalToday = round2(state.members.reduce((s, m) => s + balanceOnToday(state.capital, m.id), 0))
  const pendingCapital = state.capital.filter(c => c.status === 'pending_approval').length
  const totalRetained = round2(confirmed.reduce((s, r) => s + (r.totalRetainedInr ?? 0), 0))

  // Setup checklist (design §13).
  const { data: drawingsCats } = await admin.from('cashbook_categories').select('id').eq('account_code', 'excluded.owner_drawings')
  const catIds = (drawingsCats ?? []).map(c => c.id as string)
  let withdrawals = 0
  if (catIds.length) {
    const { count } = await admin.from('cashbook_entries').select('id', { count: 'exact', head: true })
      .in('category_id', catIds).is('deleted_at', null)
    withdrawals = count ?? 0
  }
  const reviewedWithdrawals = state.reviews.filter(r => r.category === 'personal_withdrawal').length
  const founder = state.members.find(m => m.roles.includes('founder'))
  const founderCapital = founder ? state.capital.some(c => c.memberId === founder.id && c.status === 'approved') : false
  const firstRun = state.runs[0]
  const checklist: { done: boolean; label: string; href: string; note?: string }[] = [
    { done: !!founder, label: 'Add yourself as founder, then any other investors', href: 'investors' },
    { done: founderCapital, label: 'Record and approve the founder’s opening capital, with its effective date', href: 'investors' },
    { done: !!firstRun?.openingLossEntered || confirmed.length > 0, label: 'Create the first period and enter the opening accumulated loss (D7)', href: 'periods' },
    { done: withdrawals === 0 || reviewedWithdrawals >= withdrawals, label: `Review historical Personal Withdrawals one by one (${reviewedWithdrawals} of ${withdrawals})`, href: 'investors#withdrawals' },
    { done: !!approvedDevicePolicy(state.settings), label: 'Approve a device policy before confirming any device valuation (D11)', href: 'settings', note: 'Only needed for devices' },
  ]

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Latest cash profit" value={inr(latest?.profitInr ?? null)} hint={latest ? periodLabel(latest.periodStart, latest.periodEnd) : 'No confirmed period yet'}
          tone={latest && (latest.profitInr ?? 0) < 0 ? 'bad' : undefined} />
        <Stat label="Accumulated loss" value={inr(latest ? latest.closingLossInr : null)} hint="Absorbed before anything is shared" />
        <Stat label="Pending to investors" value={inr(pendingEnt)} hint="Confirmed, not yet paid, reinvested or waived" />
        <Stat label="Business Reserve" value={inr(reserve)} hint="An earmark — it creates no cash" />
        <Stat label="Capital today" value={inr(capitalToday)} hint={pendingCapital ? `${pendingCapital} movement(s) awaiting approval` : 'Approved capital'} />
        <Stat label="Retained to date" value={inr(totalRetained)} hint="Reserve + outside the pool, confirmed periods" />
        <Stat label="Device settlements owed" value={inr(pendingDev)} hint="Confirmed device values not yet settled" />
        <Stat label="Confirmed periods" value={confirmed.length} hint={latest ? `Up to ${latest.periodEnd}` : '—'} />
      </div>

      <Card title="Setting up" subtitle="Nothing is reclassified automatically. Each step is yours to record.">
        <ul className="space-y-2 text-sm">
          {checklist.map(c => (
            <li key={c.label} className="flex items-start gap-2">
              {c.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <Circle className="mt-0.5 h-4 w-4 text-muted-foreground" />}
              <Link href={`/dashboard/finance/profit-sharing/${c.href}`} className="hover:underline">{c.label}</Link>
              {c.note && <span className="text-xs text-muted-foreground">({c.note})</span>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Still open" subtitle="Decisions you have not made yet. The app applies the conservative behaviour until you do.">
        <ul className="space-y-1.5 text-sm">
          <li className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><span><b>D1 GST/TDS:</b> invoices carrying tax go to review; no tax treatment is applied automatically.</span></li>
          <li className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><span><b>D7 Start and opening loss:</b> required on the first period before it can be confirmed.</span></li>
          <li className="flex gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /><span><b>D17 Payroll “other deductions”:</b> shown as a warning; pay is counted in full and no other treatment is assumed.</span></li>
        </ul>
      </Card>

      <Card title="Profit periods" actions={<Link href="/dashboard/finance/profit-sharing/periods" className="text-xs font-medium text-primary hover:underline">All periods</Link>}>
        {state.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No periods yet. Start with the first month of the scheme.</p>
        ) : (
          <Table head={['Period', 'Status', 'Cash profit', 'Eligible', 'Capital Share', 'Reserve', 'Closing loss']}>
            {state.runs.slice(-6).reverse().map(r => (
              <tr key={r.id} className="border-b border-border/60">
                <td className={td}><Link className="hover:underline" href={`/dashboard/finance/profit-sharing/periods/${r.id}`}>{periodLabel(r.periodStart, r.periodEnd)}</Link></td>
                <td className={td}><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td>
                <td className={tdNum}>{inr(r.profitInr)}</td>
                <td className={tdNum}>{inr(r.eligibleProfitInr)}</td>
                <td className={tdNum}>{inr(r.capitalShareInr)}</td>
                <td className={tdNum}>{inr(r.reserveInr)}</td>
                <td className={tdNum}>{inr(r.closingLossInr)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}
