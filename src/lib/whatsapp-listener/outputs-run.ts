import 'server-only'

/**
 * Posts a photo Cirqle sent to a client on WhatsApp into that client's chat
 * channel (rules: ./outputs). Called by the listener webhook once per
 * WhatsApp message, after the photo is kept; a gateway retry finds the
 * message already posted and does nothing.
 *
 * The chat message points at the same stored file — nothing is copied. The
 * sender is the employee whose saved phone sent it, when there is one.
 * People are matched by phone and shown by CQID only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { phoneMatchKey } from './rules'
import { exactIlike, outputCaption, outputFileName } from './outputs'

export interface OutputPost {
  whatsappMessageId: string
  chatId: string
  clientName: string
  caption: string
  senderPhone: string | null
  mediaPath: string
  mime: string | null
  sizeBytes: number | null
  sentAtIso: string
}

export type OutputResult = 'posted' | 'already' | 'no-client' | 'failed'

export async function postOutputToClientChannel(admin: SupabaseClient, p: OutputPost): Promise<OutputResult> {
  // The client the chat is listed for.
  const { data: clients, error: cErr } = await admin.from('clients')
    .select('id, name').ilike('name', exactIlike(p.clientName)).limit(2)
  if (cErr) { console.warn('[whatsapp-listener] output: client lookup failed:', cErr.message); return 'failed' }
  const client = (clients ?? [])[0] as { id: string; name: string } | undefined
  if (!client) return 'no-client'

  // Who sent it, when it was a teammate's own phone.
  const key = phoneMatchKey(p.senderPhone)
  let sender: { id: string; cqid: string | null } | null = null
  if (key) {
    const { data: emps } = await admin.from('employees').select('id, cqid, phone').eq('is_active', true)
    const e = ((emps ?? []) as { id: string; cqid: string | null; phone: string | null }[]).find(x => phoneMatchKey(x.phone) === key)
    if (e) sender = { id: e.id, cqid: e.cqid }
  }

  // The client's channel — the oldest open one; made when there is none yet.
  const { data: chans, error: chErr } = await admin.from('conversations')
    .select('id').eq('category', 'client').eq('client_id', client.id).in('type', ['channel', 'group'])
    .is('archived_at', null).order('created_at').limit(1)
  if (chErr) { console.warn('[whatsapp-listener] output: channel lookup failed:', chErr.message); return 'failed' }
  let conversationId = (chans ?? [])[0]?.id as string | undefined
  if (!conversationId) {
    const { data: made, error: mkErr } = await admin.from('conversations').insert({
      type: 'channel', name: client.name, topic: 'Work for this client, and what was sent to them on WhatsApp.',
      is_private: false, category: 'client', client_id: client.id, created_by: sender?.id ?? null,
    }).select('id').single()
    if (mkErr || !made) { console.warn('[whatsapp-listener] output: could not make the client channel:', mkErr?.message); return 'failed' }
    conversationId = made.id as string
    if (sender) await admin.from('conversation_members').insert({ conversation_id: conversationId, employee_id: sender.id, role: 'owner' }).then(() => {}, () => {})
  }

  // Once per WhatsApp message.
  const { data: dup } = await admin.from('messages').select('id')
    .eq('conversation_id', conversationId).contains('metadata', { whatsappMessageId: p.whatsappMessageId }).limit(1)
  if (dup?.length) return 'already'

  const { data: msg, error: mErr } = await admin.from('messages').insert({
    conversation_id: conversationId,
    sender_id: sender?.id ?? null,
    body: outputCaption(p.caption, sender?.cqid ?? null),
    kind: 'file',
    metadata: { source: 'whatsapp', whatsappMessageId: p.whatsappMessageId, whatsappChatId: p.chatId, sentAt: p.sentAtIso },
    created_at: p.sentAtIso,
  }).select('id').single()
  if (mErr || !msg) { console.warn('[whatsapp-listener] output: could not post:', mErr?.message); return 'failed' }

  const { error: aErr } = await admin.from('message_attachments').insert({
    message_id: msg.id,
    storage_path: p.mediaPath,
    file_name: outputFileName(p.mediaPath, p.sentAtIso),
    mime_type: p.mime,
    size_bytes: p.sizeBytes,
  })
  if (aErr) {
    // A message with no photo is worse than none: take it back.
    await admin.from('messages').delete().eq('id', msg.id).then(() => {}, () => {})
    console.warn('[whatsapp-listener] output: could not attach the photo:', aErr.message)
    return 'failed'
  }
  return 'posted'
}
