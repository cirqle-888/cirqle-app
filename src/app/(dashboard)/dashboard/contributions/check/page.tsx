import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { summarizeCheck, type CheckAnswer, type CheckStatus } from '@/lib/contributions/check'

export const dynamic = 'force-dynamic'

/** Contribution checks sent to me, and the ones I sent. */

const STATUS_LABEL: Record<CheckStatus, string> = { open: 'Waiting', answered: 'Answered', closed: 'Closed' }
const STATUS_TINT: Record<CheckStatus, string> = {
  open: 'bg-amber-500/12 text-amber-700 border-amber-500/25 dark:text-amber-400',
  answered: 'bg-violet-500/12 text-violet-700 border-violet-500/25 dark:text-violet-300',
  closed: 'bg-green-500/12 text-green-700 border-green-500/25 dark:text-green-400',
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const niceDate = (d: string) => { const x = new Date(d); return `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}` }

interface Row {
  id: string; employee_id: string; requested_by: string; note: string | null; status: CheckStatus; created_at: string
  items: { answer: CheckAnswer | null }[]
}

export default async function ContributionChecksPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')

  const db = createAdminClient()
  const cols = 'id, employee_id, requested_by, note, status, created_at, items:contribution_check_items(answer)'
  const [toMe, byMe, { data: emps }] = await Promise.all([
    db.from('contribution_checks').select(cols).eq('employee_id', me.employeeId).order('created_at', { ascending: false }).limit(100),
    db.from('contribution_checks').select(cols).eq('requested_by', me.employeeId).order('created_at', { ascending: false }).limit(100),
    db.from('employees').select('id, cqid'),
  ])
  const cqid = new Map(((emps ?? []) as { id: string; cqid: string }[]).map(e => [e.id, e.cqid]))
  const notReady = !!toMe.error

  const section = (title: string, rows: Row[], who: (r: Row) => string, empty: string) => (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground bg-card border border-border rounded-xl p-4">{empty}</p>
      ) : (
        <div className="divide-y divide-border bg-card border border-border rounded-xl">
          {rows.map(r => {
            const s = summarizeCheck(r.items ?? [])
            return (
              <Link key={r.id} href={`/dashboard/contributions/check/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-secondary/40">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{who(r)} · {s.total} job{s.total === 1 ? '' : 's'}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {niceDate(r.created_at)}
                    {r.status === 'open' ? ` · ${s.answered} of ${s.total} answered` : ` · ${s.worked} to look at, ${s.correct} right`}
                    {r.note ? ` · ${r.note}` : ''}
                  </p>
                </div>
                <span className={`px-2 py-0.5 rounded border text-[11px] font-medium ${STATUS_TINT[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </Link>
            )
          })}
        </div>
      )}
    </section>
  )

  return (
    <div className="min-h-screen">
      <Header title="Contribution checks" subtitle="Jobs sent to confirm someone's credit" />
      <div className="px-4 sm:px-6 lg:px-8 pb-16 max-w-4xl mx-auto mt-2 space-y-5">
        <Link href="/dashboard/contributions" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Contributions
        </Link>
        {notReady ? (
          <p className="text-sm text-muted-foreground">
            Contribution checks need the <code className="rounded bg-secondary px-1">20261111100000_contribution_checks.sql</code> migration.
          </p>
        ) : (
          <>
            {section('Sent to you', (toMe.data ?? []) as unknown as Row[], r => `From ${cqid.get(r.requested_by) ?? '—'}`, 'Nothing to check right now.')}
            {(byMe.data ?? []).length > 0 && section('Sent by you', (byMe.data ?? []) as unknown as Row[], r => `To ${cqid.get(r.employee_id) ?? '—'}`, '')}
          </>
        )}
      </div>
    </div>
  )
}
