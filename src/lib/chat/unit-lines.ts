import 'server-only'

/**
 * Business-unit lines in chat (server-only, service role).
 *
 * A non-admin on a unit's team (lib/units) talks only with their own unit and
 * with admins. These helpers apply that to the things the service role does on
 * someone's behalf — reading a conversation, listing and searching them,
 * pushing an alert — the same way the database does for the browser
 * (chat_unit_blocked() in is_conversation_member()). The rule itself lives in
 * lib/chat/access.ts (blockedByUnitLine).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { blockedByUnitLine, isUnitMember, type ChatAccessContext, type ConversationFacts } from './access'
import { anyUnitLines, loadUnitLineContext } from './access-load'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>

async function conversationFacts(admin: Admin, convIds: string[]): Promise<Map<string, ConversationFacts>> {
  const out = new Map<string, ConversationFacts>()
  if (!convIds.length) return out
  const [convs, members] = await Promise.all([
    admin.from('conversations').select('id, department_id, posting').in('id', convIds),
    admin.from('conversation_members').select('conversation_id, employee_id').in('conversation_id', convIds),
  ])
  if (convs.error) throw new Error(`Could not read conversations: ${convs.error.message}`)
  if (members.error) throw new Error(`Could not read conversation members: ${members.error.message}`)
  for (const c of (convs.data ?? []) as { id: string; department_id: string | null; posting?: string | null }[]) {
    out.set(c.id, { departmentId: c.department_id ?? null, posting: c.posting === 'admins' ? 'admins' : 'all', memberIds: [] })
  }
  for (const m of (members.data ?? []) as { conversation_id: string; employee_id: string }[]) {
    (out.get(m.conversation_id)?.memberIds as string[] | undefined)?.push(m.employee_id)
  }
  return out
}

/** The conversations among `convIds` that a unit line closes to `viewerId`. */
export async function blockedConversationIds(
  admin: Admin, viewerId: string, convIds: string[], preloaded?: ChatAccessContext,
): Promise<Set<string>> {
  if (!convIds.length) return new Set()
  if (!preloaded && !(await anyUnitLines(admin))) return new Set()
  const ctx = preloaded ?? await loadUnitLineContext(admin)
  if (ctx.adminIds.has(viewerId) || !isUnitMember(ctx, viewerId)) return new Set()
  const facts = await conversationFacts(admin, [...new Set(convIds)])
  return new Set([...facts].filter(([, f]) => blockedByUnitLine(ctx, viewerId, f)).map(([id]) => id))
}

/** Of `recipientIds`, those a unit line does not close this conversation to — for pushes and alerts. */
export async function recipientsPastUnitLines(admin: Admin, conversationId: string, recipientIds: string[]): Promise<string[]> {
  if (!recipientIds.length || !(await anyUnitLines(admin))) return recipientIds
  const ctx = await loadUnitLineContext(admin)
  if (!recipientIds.some(r => isUnitMember(ctx, r))) return recipientIds
  const facts = (await conversationFacts(admin, [conversationId])).get(conversationId)
  if (!facts) return recipientIds
  return recipientIds.filter(r => !blockedByUnitLine(ctx, r, facts))
}
