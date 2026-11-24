import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendWebPush } from '@/lib/push/send'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>

/** Device push to everyone in a conversation who wants every message, except the sender. */
export async function pushToConversation(admin: Admin, conversationId: string, senderId: string, senderCqid: string, preview: string): Promise<void> {
  const { data } = await admin
    .from('conversation_members')
    .select('employee_id, notify_level')
    .eq('conversation_id', conversationId)
  await Promise.all(((data ?? []) as { employee_id: string; notify_level: string | null }[])
    .filter(m => m.employee_id !== senderId && (m.notify_level ?? 'all') === 'all')
    .map(m => sendWebPush(m.employee_id, {
      title: `💬 ${senderCqid}`,
      body: preview.length > 120 ? `${preview.slice(0, 120)}…` : preview,
      url: `/dashboard/chat?c=${conversationId}`,
      tag: `msg:${conversationId}`,
    })))
}
