import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadMyWork } from '@/lib/requests/my-work-load'
import { loadPostQueue } from '@/lib/social-hub/post-queue-load'
import { toISODate } from '@/lib/utils/local-date'
import MyWorkClient from './my-work-client'
import { stageOf, stageOfPlan, isPending } from '@/lib/requests/my-work'
import PostQueueClient from '../social/queue/post-queue-client'

export const dynamic = 'force-dynamic'

/** The board stage of a loaded row — same rule the client uses. */
const rowStageOf = (r: { source?: string; status: string }) => r.source === 'plan' ? stageOfPlan(r.status) : stageOf(r.status)

/**
 * My Work — one person's own queue.
 *
 * Gated on requests.work_own, NOT requests.view: the whole point is that a
 * designer reaches this without the inbox being opened to them. Admins pass
 * via hasPermission's is_admin short-circuit and simply see their own assigned
 * rows (usually none), which is correct — this page is never a management view.
 */
export default async function MyWorkPage({ searchParams }: { searchParams: Promise<{ for?: string }> }) {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  // Whoever runs the work (requests.manage — admin, content planner, task
  // manager) can open a team member's board and move cards for them.
  const canManageTeam = hasPermission(me, PERMS.REQUESTS_MANAGE)
  if (!hasPermission(me, PERMS.REQUESTS_WORK_OWN) && !canManageTeam) redirect('/dashboard')

  const admin = createAdminClient()

  // Team: everyone active with work on their board, busiest-late first.
  let team: { employeeId: string; cqid: string; open: number; overdue: number }[] = []
  if (canManageTeam) {
    const { data: emps } = await admin.from('employees').select('id, cqid').eq('is_active', true).order('cqid')
    const today = toISODate(new Date())
    const loads = await Promise.all(((emps ?? []) as { id: string; cqid: string }[]).map(async e => {
      const work = await loadMyWork(admin, e.id).catch(() => [])
      const open = work.filter(r => isPending(rowStageOf(r))).length
      const overdue = work.filter(r => isPending(rowStageOf(r)) && r.due_date && r.due_date < today).length
      return { employeeId: e.id, cqid: e.cqid, open, overdue }
    }))
    team = loads.filter(t => t.open > 0 || t.employeeId === me.employeeId)
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.cqid.localeCompare(b.cqid))
  }

  const { for: forId } = await searchParams
  const viewing = canManageTeam && forId && forId !== me.employeeId ? team.find(t => t.employeeId === forId)
    ?? await admin.from('employees').select('id, cqid').eq('id', forId).maybeSingle()
      .then(({ data }) => data ? { employeeId: data.id as string, cqid: data.cqid as string, open: 0, overdue: 0 } : null)
    : null
  const rows = await loadMyWork(admin, viewing ? viewing.employeeId : me.employeeId)

  // The posting half, for whoever also runs the accounts. Someone who only
  // designs never holds social.publish, so this section simply is not there
  // for them — no empty board, no explaining why it is empty.
  //
  // Not filtered by assignee: unlike design work, publishing has no per-person
  // assignment on a calendar item. Anyone trusted to post is trusted with the
  // whole queue, which is also what makes cover during leave possible.
  const canPost = hasPermission(me, PERMS.SOCIAL_PUBLISH)
  const queue = canPost
    ? (await loadPostQueue(admin, toISODate(new Date()))).filter(
        r => r.stage === 'to_prepare' || r.stage === 'ready',
      )
    : []

  return (
    <>
      <MyWorkClient
        // A new board per person — the card state must not carry across.
        key={viewing?.employeeId ?? 'me'}
        initialRows={rows}
        firstName={(me.name || '').split(' ')[0] || 'there'}
        team={canManageTeam ? team : []}
        viewing={viewing ? { employeeId: viewing.employeeId, cqid: viewing.cqid } : null}
        myEmployeeId={me.employeeId}
      />
      {!viewing && canPost && queue.length > 0 && (
        <div className="px-4 sm:px-6 pb-6">
          <div className="border-t border-border pt-5">
            <PostQueueClient
              initialRows={queue}
              targets={{}}
              canPublishApi={hasPermission(me, PERMS.SOCIAL_APPROVE)}
              variant="compact"
            />
          </div>
        </div>
      )}
    </>
  )
}
