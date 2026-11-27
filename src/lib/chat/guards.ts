import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission, type CurrentUser } from '@/lib/permissions/check'
import { blockedConversationIds } from './unit-lines'

/**
 * Signed in and allowed into chat — the same gate as chat/actions.ts.
 * Pass `write` for anything that changes data: an admin previewing as someone
 * else may look, but never act as them.
 */
export async function requireChatUser(write = false) {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  if (!hasPermission(me, 'chat.access')) return { ok: false as const, error: 'You do not have access to chat.' }
  if (write && me.isViewAs) return { ok: false as const, error: 'Preview is read-only.' }
  return { ok: true as const, me }
}

export async function requireMembership(conversationId: string, employeeId: string) {
  const admin = createAdminClient()
  const { data } = await admin
    .from('conversation_members')
    .select('role')
    .eq('conversation_id', conversationId)
    .eq('employee_id', employeeId)
    .maybeSingle()
  if (!data) return { ok: false as const, error: 'You are not a member of this conversation.' }
  // A business-unit team member may not use a conversation that includes
  // people outside their unit (lib/chat/access → blockedByUnitLine).
  if ((await blockedConversationIds(admin, employeeId, [conversationId])).size) {
    return { ok: false as const, error: 'This conversation includes people outside your unit.' }
  }
  return { ok: true as const, role: data.role as 'owner' | 'moderator' | 'member' }
}

/**
 * An announcement channel takes new posts only from admins, chat moderators
 * and the channel's own owner / moderators. Thread replies stay open to all,
 * so people can still answer an announcement without filling the channel.
 */
export async function requireCanPost(
  me: CurrentUser,
  conversationId: string,
  role: 'owner' | 'moderator' | 'member',
  isThreadReply = false,
) {
  if (isThreadReply) return { ok: true as const }
  // select('*'): the column arrives with the chat upgrade migration.
  const { data: conv } = await createAdminClient().from('conversations').select('*').eq('id', conversationId).maybeSingle()
  if (!conv || conv.posting !== 'admins') return { ok: true as const }
  if (me.isAdmin || hasPermission(me, 'chat.moderate') || role === 'owner' || role === 'moderator') return { ok: true as const }
  return { ok: false as const, error: 'Only admins can post in this channel. You can react, or reply in a thread.' }
}
