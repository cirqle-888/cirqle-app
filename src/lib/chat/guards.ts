import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'

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
  return data
    ? { ok: true as const, role: data.role as 'owner' | 'moderator' | 'member' }
    : { ok: false as const, error: 'You are not a member of this conversation.' }
}
