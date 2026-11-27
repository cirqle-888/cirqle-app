import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendWebPush } from '@/lib/push/send'
import { recipientsPastUnitLines } from './unit-lines'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>

/** Device push to everyone in a conversation who wants every message, except the sender. */
export async function pushToConversation(admin: Admin, conversationId: string, senderId: string, senderCqid: string, preview: string): Promise<void> {
  const { data } = await admin
    .from('conversation_members')
    .select('employee_id, notify_level')
    .eq('conversation_id', conversationId)
  const rows = (data ?? []) as { employee_id: string; notify_level: string | null }[]
  // Nobody is alerted about a conversation a unit line closes to them.
  const allowed = new Set(await recipientsPastUnitLines(admin, conversationId, rows.map(m => m.employee_id)))
  await Promise.all(rows
    .filter(m => m.employee_id !== senderId && allowed.has(m.employee_id) && (m.notify_level ?? 'all') === 'all')
    .map(m => sendWebPush(m.employee_id, {
      title: `💬 ${senderCqid}`,
      body: preview.length > 120 ? `${preview.slice(0, 120)}…` : preview,
      url: `/dashboard/chat?c=${conversationId}`,
      tag: `msg:${conversationId}`,
    })))
}
