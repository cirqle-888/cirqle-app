import Link from 'next/link'
import { loadRuns, nextPeriodStart, todayIso } from '../_data'
import { requireProfitSharingPage } from '../_page'
import { NotInstalled } from '../_not-installed'
import { Badge, Card, Empty, STATUS_TONE, Table, inr, periodLabel, td, tdNum } from '../_components'
import NewPeriodForm from './new-period-form'

export const dynamic = 'force-dynamic'

export default async function PeriodsPage() {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />
  const runs = await loadRuns(admin)
  const next = nextPeriodStart(runs)

  return (
    <>
      <Card title="New period" subtitle={next
        ? `Periods are whole months, follow on without gaps, and are confirmed in order. The next one starts ${next}.`
        : 'The first period’s start month is the scheme start. You will enter its opening accumulated loss (D7) before it can be confirmed.'}>
        <NewPeriodForm fixedStart={next ? next.slice(0, 7) : null} defaultEnd={todayIso().slice(0, 7)} />
      </Card>

      <Card title="Periods">
        {runs.length === 0 ? <Empty>No periods yet.</Empty> : (
          <Table head={['Period', 'Status', 'Cash profit', 'Eligible', 'Pool', 'Capital Share', 'Reserve', 'Closing loss']}>
            {[...runs].reverse().map(r => (
              <tr key={r.id} className="border-b border-border/60">
                <td className={td}><Link className="font-medium hover:underline" href={`/dashboard/finance/profit-sharing/periods/${r.id}`}>{periodLabel(r.periodStart, r.periodEnd)}</Link></td>
                <td className={td}><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td>
                <td className={tdNum}>{inr(r.profitInr)}</td>
                <td className={tdNum}>{inr(r.eligibleProfitInr)}</td>
                <td className={tdNum}>{inr(r.poolInr)}</td>
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
