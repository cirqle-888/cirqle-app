'use server'

/**
 * Comment inbox — server actions.
 *
 * Replies, hides and deletes go straight to Meta; nothing is queued. A reply
 * that only reached our database would be worse than no feature at all, since
 * the queue would show it answered while the customer waited.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import {
  loadAccountInbox, replyToComment, setCommentHidden, deleteComment,
  type InboxPost,
} from '@/lib/integrations/meta/comments'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const REVALIDATE = '/dashboard/social/inbox'

/** Recent posts and their comment threads for one account. */
export async function loadInbox(accountId: string): Promise<ActionResult<{ posts: InboxPost[] }>> {
  const guard = await requireReadPermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const res = await loadAccountInbox(admin, accountId, 15)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, data: { posts: res.posts } }
}

export async function sendReply(
  accountId: string,
  commentId: string,
  message: string,
): Promise<ActionResult<{ id?: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const res = await replyToComment(admin, accountId, commentId, message)
  if (!res.ok) return { ok: false, error: res.error }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'social_account', entityId: accountId,
    category: 'crm', action: 'social_comment_replied',
    detail: { comment_id: commentId, length: message.trim().length },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: res.id } }
}

/** Hide keeps it visible to its author — the usual answer to spam. */
export async function hideComment(
  accountId: string,
  commentId: string,
  hidden: boolean,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const res = await setCommentHidden(admin, accountId, commentId, hidden)
  if (!res.ok) return { ok: false, error: res.error }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Irreversible on both platforms, so it is gated on approve, not publish. */
export async function removeComment(
  accountId: string,
  commentId: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_APPROVE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const res = await deleteComment(admin, accountId, commentId)
  if (!res.ok) return { ok: false, error: res.error }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'social_account', entityId: accountId,
    category: 'crm', action: 'social_comment_deleted',
    detail: { comment_id: commentId },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Record that a comment was deliberately left unanswered.
 *
 * Meta has no notion of this, so without it a "🔥" sits at the top of the queue
 * forever and people stop trusting the count.
 */
export async function dismissComment(
  accountId: string,
  commentId: string,
  dismissed: boolean,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_PUBLISH)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  if (dismissed) {
    const { error } = await admin.from('social_comment_state').upsert({
      comment_id: commentId,
      account_id: accountId,
      state: 'dismissed',
      handled_by: guard.employeeId ?? null,
      handled_at: new Date().toISOString(),
    })
    if (error) return { ok: false, error: error.message }
  } else {
    const { error } = await admin.from('social_comment_state').delete().eq('comment_id', commentId)
    if (error) return { ok: false, error: error.message }
  }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Comment ids someone has already decided not to answer. */
export async function loadDismissed(accountId: string): Promise<string[]> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('social_comment_state').select('comment_id').eq('account_id', accountId)
  // Absent table (pre-migration) simply means nothing has been dismissed yet.
  if (error) return []
  return ((data ?? []) as { comment_id: string }[]).map(r => r.comment_id)
}
