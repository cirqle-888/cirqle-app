import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pushToConversation } from './notify'
import { attachLinkPreview } from './link-preview'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>

let lastRun = 0

/**
 * Send every scheduled message whose time has come.
 *
 * There is no minute-by-minute timer on this hosting plan, so this runs
 * whenever anyone's app refreshes its chat list (every 90 seconds on the chat
 * page, every few minutes elsewhere). A message is therefore sent at its time
 * if anyone has the app open, and otherwise the moment the first person opens it.
 *
 * Each row is claimed with a conditional update, so two people refreshing at
 * once can never send the same message twice.
 */
export async function deliverDueScheduled(admin: Admin): Promise<number> {
  const now = Date.now()
  if (now - lastRun < 20_000) return 0
  lastRun = now
  const nowIso = new Date(now).toISOString()

  const { data: due, error } = await admin
    .from('chat_scheduled_messages')
    .select('id')
    .lte('send_at', nowIso).is('sent_at', null).is('cancelled_at', null)
    .order('send_at', { ascending: true })
    .limit(20)
  if (error || !due?.length) return 0

  let sent = 0
  for (const { id } of due as { id: string }[]) {
    const { data: row } = await admin
      .from('chat_scheduled_messages')
      .update({ sent_at: nowIso })
      .eq('id', id).is('sent_at', null).is('cancelled_at', null)
      .select('id, conversation_id, sender_id, body, sender:sender_id(cqid)')
      .maybeSingle()
    if (!row) continue // someone else claimed it

    const fail = (reason: string) => admin.from('chat_scheduled_messages').update({ error: reason }).eq('id', id)
    const [{ data: member }, { data: conv }] = await Promise.all([
      admin.from('conversation_members').select('employee_id')
        .eq('conversation_id', row.conversation_id).eq('employee_id', row.sender_id).maybeSingle(),
      admin.from('conversations').select('archived_at').eq('id', row.conversation_id).maybeSingle(),
    ])
    if (!member) { await fail('Sender is no longer in the conversation.'); continue }
    if (!conv || conv.archived_at) { await fail('The conversation was deleted.'); continue }

    const { data: msg, error: insErr } = await admin
      .from('messages')
      .insert({
        conversation_id: row.conversation_id, sender_id: row.sender_id,
        body: row.body, kind: 'text', metadata: { scheduled: true },
      })
      .select('id')
      .single()
    if (insErr || !msg) { await fail(insErr?.message ?? 'Could not send.'); continue }

    await admin.from('chat_scheduled_messages').update({ sent_message_id: msg.id }).eq('id', id)
    const sender = Array.isArray(row.sender) ? row.sender[0] : row.sender
    const cqid = (sender as { cqid?: string } | null)?.cqid ?? 'Someone'
    await Promise.all([
      pushToConversation(admin, row.conversation_id as string, row.sender_id as string, cqid, row.body as string),
      attachLinkPreview(msg.id as string, row.body as string),
    ]).catch(() => {})
    sent++
  }
  return sent
}
