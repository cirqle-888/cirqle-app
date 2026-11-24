import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'

/** Signed in and allowed into chat. Same gate as chat/actions.ts. */
export async function requireChatUser() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  if (!hasPermission(me, 'chat.access')) return { ok: false as const, error: 'You do not have access to chat.' }
  if (me.isViewAs) return { ok: false as const, error: 'Preview is read-only.' }
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
