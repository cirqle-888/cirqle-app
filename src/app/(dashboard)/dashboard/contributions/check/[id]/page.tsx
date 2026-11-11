import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import Header from '@/components/layout/header'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { checkAccess, type CheckAnswer, type CheckStatus } from '@/lib/contributions/check'
import CheckClient, { type CheckJob } from './check-client'

export const dynamic = 'force-dynamic'

/**
 * One contribution check. The person it was sent to answers each job here;
 * the sender (or an admin) reviews the answers and fixes any split on the
 * Contributions page. The person answering sees only their OWN credit on each
 * job — the same privacy the Contributions page keeps.
 */

type One<T> = T | T[] | null
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v)

interface ItemRow {
  id: string; task_id: string; answer: CheckAnswer | null; comment: string | null
  task: One<{
    task_number: number | null; title: string | null; task_date: string | null; deleted_at: string | null
    client: One<{ name: string; code: string | null }>
    service: One<{ name: string }>
  }>
}

export default async function ContributionCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')

  const db = createAdminClient()
  const { data: check, error } = await db.from('contribution_checks')
    .select('id, employee_id, requested_by, note, view_href, status, created_at, answered_at, closed_at')
    .eq('id', id).maybeSingle()

  if (error) {
    return (
      <div className="min-h-screen">
        <Header title="Contribution check" />
        <p className="px-4 sm:px-6 lg:px-8 mt-4 text-sm text-muted-foreground">
          Contribution checks need the <code className="rounded bg-secondary px-1">20261111100000_contribution_checks.sql</code> migration.
        </p>
      </div>
    )
  }
  if (!check) notFound()

  const access = checkAccess({ employeeId: me.employeeId, isAdmin: me.isAdmin }, check as { employee_id: string; requested_by: string; status: CheckStatus })
  if (!access) redirect('/dashboard/contributions')

  const { data: itemRows } = await db.from('contribution_check_items')
    .select('id, task_id, answer, comment, task:tasks(task_number, title, task_date, deleted_at, client:clients(name, code), service:services!service_id(name))')
    .eq('check_id', id)
  const items = (itemRows ?? []) as unknown as ItemRow[]
  const taskIds = items.map(i => i.task_id)

  // Who is credited on each job. The person answering gets only their own
  // row; the sender and admins see everyone, as on the Contributions page.
  let scoreQuery = db.from('contribution_scores').select('task_id, employee_id, score_percentage').in('task_id', taskIds.length ? taskIds : ['00000000-0000-0000-0000-000000000000'])
  if (access !== 'review') scoreQuery = scoreQuery.eq('employee_id', check.employee_id)
  const [{ data: scoreRows }, { data: emps }] = await Promise.all([
    scoreQuery,
    db.from('employees').select('id, cqid'),
  ])
  const cqid = new Map(((emps ?? []) as { id: string; cqid: string }[]).map(e => [e.id, e.cqid]))

  const credit = new Map<string, { cqid: string; pct: number; isThem: boolean }[]>()
  for (const s of (scoreRows ?? []) as { task_id: string; employee_id: string; score_percentage: number | null }[]) {
    const list = credit.get(s.task_id) ?? []
    list.push({ cqid: cqid.get(s.employee_id) ?? '—', pct: Number(s.score_percentage ?? 0), isThem: s.employee_id === check.employee_id })
    credit.set(s.task_id, list)
  }

  const jobs: CheckJob[] = items.map(i => {
    const t = one(i.task)
    const c = one(t?.client ?? null)
    return {
      itemId: i.id,
      taskNumber: t?.task_number ?? null,
      title: t?.deleted_at ? `${t?.title ?? 'Job'} (deleted)` : (t?.title ?? 'Job no longer exists'),
      date: t?.task_date ?? null,
      client: c ? c.name : null,
      clientCode: c?.code ?? null,
      service: one(t?.service ?? null)?.name ?? null,
      answer: i.answer,
      comment: i.comment,
      credit: (credit.get(i.task_id) ?? []).sort((a, b) => b.pct - a.pct),
    }
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || (b.taskNumber ?? 0) - (a.taskNumber ?? 0))

  return (
    <div className="min-h-screen">
      <Header title="Contribution check" subtitle={access === 'review' ? 'Answers to the jobs you sent' : 'Confirm your credit on these jobs'} />
      <div className="px-4 sm:px-6 lg:px-8 pb-24 max-w-4xl mx-auto mt-2 space-y-4">
        <Link href="/dashboard/contributions/check" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-3.5 h-3.5" /> All checks
        </Link>
        <CheckClient
          checkId={check.id}
          access={access}
          status={check.status as CheckStatus}
          employee={cqid.get(check.employee_id) ?? '—'}
          requester={cqid.get(check.requested_by) ?? '—'}
          note={check.note}
          viewHref={check.view_href}
          createdAt={check.created_at}
          answeredAt={check.answered_at}
          jobs={jobs}
        />
      </div>
    </div>
  )
}
