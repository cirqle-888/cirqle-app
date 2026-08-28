import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadMyWork } from '@/lib/requests/my-work-load'
import { loadPostQueue } from '@/lib/social-hub/post-queue-load'
import { toISODate } from '@/lib/utils/local-date'
import MyWorkClient from './my-work-client'
import PostQueueClient from '../social/queue/post-queue-client'

export const dynamic = 'force-dynamic'

/**
 * My Work — one person's own queue.
 *
 * Gated on requests.work_own, NOT requests.view: the whole point is that a
 * designer reaches this without the inbox being opened to them. Admins pass
 * via hasPermission's is_admin short-circuit and simply see their own assigned
 * rows (usually none), which is correct — this page is never a management view.
 */
export default async function MyWorkPage() {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!hasPermission(me, PERMS.REQUESTS_WORK_OWN)) redirect('/dashboard')

  const admin = createAdminClient()
  const rows = await loadMyWork(admin, me.employeeId)

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
      <MyWorkClient initialRows={rows} firstName={(me.name || '').split(' ')[0] || 'there'} />
      {canPost && queue.length > 0 && (
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
