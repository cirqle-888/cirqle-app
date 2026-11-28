'use server'

/**
 * Chat — the WhatsApp/Slack conveniences added on top of chat/actions.ts:
 * pin and mute a chat, star and pin messages, forward, shared media, polls,
 * scheduled messages, and the admin's rules for who may chat with whom.
 *
 * Same pattern as actions.ts: check the caller, then write with the service
 * role. Pins, poll tallies and link previews are written into
 * messages.metadata, so every open client hears about them through the
 * realtime UPDATE it already listens to.
 */

import { after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireChatUser, requireMembership, requireCanPost } from '@/lib/chat/guards'
import { hasPermission } from '@/lib/permissions/check'
import { departmentSlug } from '@/lib/chat/mentions'
import { loadChatAccess, loadChatAccessRules, loadDepartmentsByEmployee } from '@/lib/chat/access-load'
import { canChat, type ChatAccessMode, type ChatAccessRule } from '@/lib/chat/access'
import { buildPoll, readPoll, tallyVotes, type PollData } from '@/lib/chat/polls'
import { extractUrls } from '@/lib/chat/links'
import { pushToConversation } from '@/lib/chat/notify'
import { blockedConversationIds } from '@/lib/chat/unit-lines'
import { logActivity } from '@/lib/activity/log'

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

// ── My settings for one chat ──────────────────────────────────────────────────

/** Pin a chat to the top of my list (or unpin). Follows me to every device. */
export async function setConversationPinned(conversationId: string, pinned: boolean): Promise<Result<null>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const membership = await requireMembership(conversationId, auth.me.employeeId)
  if (!membership.ok) return membership
  const { error } = await createAdminClient()
    .from('conversation_members')
    .update({ pinned_at: pinned ? new Date().toISOString() : null })
    .eq('conversation_id', conversationId).eq('employee_id', auth.me.employeeId)
  if (error) return { ok: false, error: /pinned_at/.test(error.message) ? 'Pinning needs the chat upgrade migration.' : error.message }
  return { ok: true, data: null }
}

export type NotifyLevel = 'all' | 'mentions' | 'none'

/** all = every message · mentions = only when I am mentioned · none = muted. */
export async function setConversationNotify(conversationId: string, level: NotifyLevel): Promise<Result<null>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  if (!['all', 'mentions', 'none'].includes(level)) return { ok: false, error: 'Unknown setting.' }
  const membership = await requireMembership(conversationId, auth.me.employeeId)
  if (!membership.ok) return membership
  const { error } = await createAdminClient()
    .from('conversation_members')
    .update({ notify_level: level })
    .eq('conversation_id', conversationId).eq('employee_id', auth.me.employeeId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

// ── Starred + pinned messages ─────────────────────────────────────────────────

export interface SavedMessage {
  id: string
  conversationId: string
  conversationName: string | null
  conversationType: string
  senderName: string | null
  senderCqid: string | null
  body: string
  kind: string
  createdAt: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSaved(r: any): SavedMessage {
  const sender = Array.isArray(r.sender) ? r.sender[0] : r.sender
  const conv = Array.isArray(r.conversation) ? r.conversation[0] : r.conversation
  return {
    id: r.id,
    conversationId: r.conversation_id,
    conversationName: conv?.name ?? null,
    conversationType: conv?.type ?? 'channel',
    senderName: null,
    senderCqid: sender?.cqid ?? null,
    body: r.kind === 'voice' ? ((r.metadata?.transcript as string | undefined) ?? 'Voice message') : (r.body || (r.kind === 'file' ? 'File' : '')),
    kind: r.kind ?? 'text',
    createdAt: r.created_at,
  }
}

const SAVED_SELECT = 'id, conversation_id, body, kind, metadata, created_at, deleted_at, sender:sender_id(cqid), conversation:conversation_id(name, type)'

/** Star a message for myself (or remove the star). Returns the new state. */
export async function toggleStar(messageId: string): Promise<Result<{ starred: boolean }>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()
  const { data: msg } = await admin.from('messages').select('id, conversation_id').eq('id', messageId).maybeSingle()
  if (!msg) return { ok: false, error: 'Message not found.' }
  const membership = await requireMembership(msg.conversation_id, me.employeeId)
  if (!membership.ok) return membership

  const { data: existing, error: readErr } = await admin.from('message_stars')
    .select('message_id').eq('message_id', messageId).eq('employee_id', me.employeeId).maybeSingle()
  if (readErr) return { ok: false, error: 'Starring needs the chat upgrade migration.' }
  if (existing) {
    await admin.from('message_stars').delete().eq('message_id', messageId).eq('employee_id', me.employeeId)
    return { ok: true, data: { starred: false } }
  }
  const { error } = await admin.from('message_stars')
    .insert({ message_id: messageId, employee_id: me.employeeId, conversation_id: msg.conversation_id })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { starred: true } }
}

/** Ids of the messages I starred in one conversation — to draw the star on them. */
export async function listStarredIds(conversationId: string): Promise<Result<string[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const { data, error } = await createAdminClient().from('message_stars')
    .select('message_id').eq('employee_id', auth.me.employeeId).eq('conversation_id', conversationId)
  if (error) return { ok: true, data: [] }
  return { ok: true, data: (data ?? []).map(r => r.message_id as string) }
}

/** Everything I starred, newest first — only from chats I am still in. */
export async function listStarred(): Promise<Result<SavedMessage[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const [{ data: stars, error }, { data: memberships }] = await Promise.all([
    admin.from('message_stars').select('message_id, created_at')
      .eq('employee_id', auth.me.employeeId).order('created_at', { ascending: false }).limit(100),
    admin.from('conversation_members').select('conversation_id').eq('employee_id', auth.me.employeeId),
  ])
  if (error || !stars?.length) return { ok: true, data: [] }
  const memberOf = (memberships ?? []).map(m => m.conversation_id as string)
  const closed = await blockedConversationIds(admin, auth.me.employeeId, memberOf)
  const mine = new Set(memberOf.filter(id => !closed.has(id)))
  const { data: rows } = await admin.from('messages').select(SAVED_SELECT).in('id', stars.map(s => s.message_id))
  const byId = new Map((rows ?? []).filter(r => !r.deleted_at && mine.has(r.conversation_id)).map(r => [r.id as string, toSaved(r)]))
  return { ok: true, data: stars.map(s => byId.get(s.message_id as string)).filter((m): m is SavedMessage => !!m) }
}

/** Pin a message for everyone in the chat (or unpin). Any member may. */
export async function togglePinMessage(messageId: string): Promise<Result<{ pinned: boolean }>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()
  const { data: msg } = await admin.from('messages')
    .select('id, conversation_id, metadata, deleted_at').eq('id', messageId).maybeSingle()
  if (!msg || msg.deleted_at) return { ok: false, error: 'Message not found.' }
  const membership = await requireMembership(msg.conversation_id, me.employeeId)
  if (!membership.ok) return membership

  const metadata = { ...((msg.metadata as Record<string, unknown>) ?? {}) }
  const wasPinned = !!metadata.pinned
  if (wasPinned) delete metadata.pinned
  else metadata.pinned = { byId: me.employeeId, by: me.cqid, at: new Date().toISOString() }
  const { error } = await admin.from('messages').update({ metadata }).eq('id', messageId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { pinned: !wasPinned } }
}

export async function listPinnedMessages(conversationId: string): Promise<Result<SavedMessage[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const membership = await requireMembership(conversationId, auth.me.employeeId)
  if (!membership.ok) return membership
  const { data, error } = await createAdminClient().from('messages')
    .select(SAVED_SELECT)
    .eq('conversation_id', conversationId).is('deleted_at', null)
    .not('metadata->pinned', 'is', null)
    .order('created_at', { ascending: false }).limit(50)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).map(toSaved) }
}

// ── Forward ───────────────────────────────────────────────────────────────────

/**
 * Forward messages into other chats. Text, files and voice notes can be
 * forwarded; approvals, polls and system lines cannot. A forwarded file points
 * at the same stored file — nothing is copied or re-uploaded.
 */
export async function forwardMessages(messageIds: string[], targetConversationIds: string[]): Promise<Result<{ sent: number }>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  const ids = [...new Set(messageIds)].slice(0, 20)
  const targets = [...new Set(targetConversationIds)].slice(0, 10)
  if (!ids.length || !targets.length) return { ok: false, error: 'Pick a message and at least one chat.' }

  const admin = createAdminClient()
  const [{ data: memberships }, { data: sources }] = await Promise.all([
    admin.from('conversation_members').select('conversation_id').eq('employee_id', me.employeeId),
    admin.from('messages')
      .select('id, conversation_id, body, kind, metadata, deleted_at, created_at')
      .in('id', ids).order('created_at', { ascending: true }),
  ])
  const memberOf = (memberships ?? []).map(m => m.conversation_id as string)
  const closed = await blockedConversationIds(admin, me.employeeId, memberOf)
  const mine = new Set(memberOf.filter(id => !closed.has(id)))
  const usable = (sources ?? []).filter(m =>
    !m.deleted_at && mine.has(m.conversation_id) && ['text', 'file', 'voice'].includes(m.kind)
    && !(m.metadata as Record<string, unknown> | null)?.poll)
  if (!usable.length) return { ok: false, error: 'These messages cannot be forwarded.' }

  const { data: convs } = await admin.from('conversations')
    .select('*, members:conversation_members(employee_id, role)').in('id', targets)
  const mayModerate = me.isAdmin || hasPermission(me, 'chat.moderate')
  const liveTargets = (convs ?? []).filter(c => {
    if (!mine.has(c.id) || c.archived_at) return false
    if (c.posting !== 'admins' || mayModerate) return true
    const myRole = ((c.members ?? []) as { employee_id: string; role: string }[]).find(m => m.employee_id === me.employeeId)?.role
    return myRole === 'owner' || myRole === 'moderator'
  })
  if (!liveTargets.length) return { ok: false, error: 'You are not a member of those chats.' }

  // A direct chat the admin has closed stays closed for forwards too.
  const dmTargets = liveTargets.filter(c => c.type === 'dm')
  if (dmTargets.length) {
    const access = await loadChatAccess(admin, me)
    for (const c of dmTargets) {
      const other = ((c.members ?? []) as { employee_id: string }[]).find(m => m.employee_id !== me.employeeId)?.employee_id
      if (other && !canChat(access, me.employeeId, other)) {
        return { ok: false, error: 'One of those direct chats is not open to you.' }
      }
    }
  }

  const { data: attachments } = await admin.from('message_attachments')
    .select('message_id, storage_path, file_name, mime_type, size_bytes').in('message_id', usable.map(m => m.id))

  let sent = 0
  for (const target of liveTargets) {
    for (const src of usable) {
      const meta = (src.metadata ?? {}) as Record<string, unknown>
      const metadata: Record<string, unknown> = { forwarded: true }
      if (src.kind === 'voice') {
        for (const k of ['durationMs', 'peaks', 'transcript', 'transcriptStatus']) if (meta[k] !== undefined) metadata[k] = meta[k]
      }
      if (meta.linkPreview) metadata.linkPreview = meta.linkPreview
      const { data: msg, error } = await admin.from('messages')
        .insert({ conversation_id: target.id, sender_id: me.employeeId, body: src.body ?? '', kind: src.kind, metadata })
        .select('id, created_at').single()
      if (error || !msg) continue
      const files = (attachments ?? []).filter(a => a.message_id === src.id)
      if (files.length) {
        await admin.from('message_attachments').insert(files.map(a => ({
          message_id: msg.id, storage_path: a.storage_path, file_name: a.file_name,
          mime_type: a.mime_type, size_bytes: a.size_bytes,
        })))
      }
      sent++
    }
    void admin.from('conversation_members')
      .update({ last_read_at: new Date().toISOString() })
      .eq('conversation_id', target.id).eq('employee_id', me.employeeId).then(undefined, () => {})
    const first = usable[0]
    const preview = first.kind === 'voice' ? '🎤 Voice message' : first.kind === 'file' ? '📎 File' : (first.body ?? '')
    after(() => pushToConversation(admin, target.id, me.employeeId, me.cqid, preview))
  }
  return { ok: true, data: { sent } }
}

// ── Media, files and links of one chat ────────────────────────────────────────

export interface SharedFile {
  attachmentId: string
  messageId: string
  fileName: string
  mimeType: string | null
  sizeBytes: number | null
  createdAt: string
  senderCqid: string | null
  /** Signed for an hour — images only, so the grid can show them. */
  url: string | null
}
export interface SharedLink { messageId: string; url: string; createdAt: string; senderCqid: string | null; title: string | null }

export async function listSharedContent(conversationId: string): Promise<Result<{ media: SharedFile[]; files: SharedFile[]; links: SharedLink[] }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const membership = await requireMembership(conversationId, auth.me.employeeId)
  if (!membership.ok) return membership
  const admin = createAdminClient()

  const [{ data: atts }, { data: linkRows }] = await Promise.all([
    admin.from('message_attachments')
      .select('id, storage_path, file_name, mime_type, size_bytes, message:message_id!inner(id, conversation_id, kind, deleted_at, created_at, sender:sender_id(cqid))')
      .eq('message.conversation_id', conversationId).is('message.deleted_at', null)
      .order('created_at', { ascending: false }).limit(120),
    admin.from('messages')
      .select('id, body, metadata, created_at, sender:sender_id(cqid)')
      .eq('conversation_id', conversationId).is('deleted_at', null).ilike('body', '%http%')
      .order('created_at', { ascending: false }).limit(80),
  ])

  const media: SharedFile[] = [], files: SharedFile[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const a of (atts ?? []) as any[]) {
    const msg = Array.isArray(a.message) ? a.message[0] : a.message
    if (!msg || msg.kind === 'voice') continue
    const sender = Array.isArray(msg.sender) ? msg.sender[0] : msg.sender
    const item: SharedFile & { path: string } = {
      attachmentId: a.id, messageId: msg.id, fileName: a.file_name, mimeType: a.mime_type, sizeBytes: a.size_bytes,
      createdAt: msg.created_at, senderCqid: sender?.cqid ?? null, url: null, path: a.storage_path,
    }
    if ((a.mime_type ?? '').startsWith('image/') && media.length < 40) media.push(item)
    else files.push(item)
  }
  await Promise.all(media.map(async m => {
    const { data } = await admin.storage.from('chat-attachments').createSignedUrl((m as SharedFile & { path: string }).path, 3600)
    m.url = data?.signedUrl ?? null
  }))
  const strip = (list: SharedFile[]) => list.map(({ ...f }) => { delete (f as { path?: string }).path; return f })

  const links: SharedLink[] = []
  for (const r of linkRows ?? []) {
    const sender = Array.isArray(r.sender) ? r.sender[0] : r.sender
    const preview = (r.metadata as { linkPreview?: { url?: string; title?: string } } | null)?.linkPreview
    for (const url of extractUrls(r.body ?? '')) {
      links.push({
        messageId: r.id, url, createdAt: r.created_at,
        senderCqid: (sender as { cqid?: string } | null)?.cqid ?? null,
        title: preview?.title && links.every(l => l.messageId !== r.id) ? preview.title : null,
      })
    }
  }
  return { ok: true, data: { media: strip(media), files: strip(files), links: links.slice(0, 100) } }
}

// ── Polls ─────────────────────────────────────────────────────────────────────

export async function createPoll(conversationId: string, question: string, options: string[], multi: boolean): Promise<Result<{ id: string }>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  const membership = await requireMembership(conversationId, me.employeeId)
  if (!membership.ok) return membership
  const mayPost = await requireCanPost(me, conversationId, membership.role)
  if (!mayPost.ok) return mayPost
  const built = buildPoll(question, options, multi)
  if (!built.ok) return built

  const admin = createAdminClient()
  const { data: conv } = await admin.from('conversations').select('archived_at').eq('id', conversationId).maybeSingle()
  if (!conv || conv.archived_at) return { ok: false, error: 'This conversation was deleted.' }
  const { data, error } = await admin.from('messages')
    // The question is the body, so search and the chat list preview both find it.
    .insert({ conversation_id: conversationId, sender_id: me.employeeId, body: built.poll.question, kind: 'text', metadata: { poll: built.poll } })
    .select('id').single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create the poll.' }
  after(() => pushToConversation(admin, conversationId, me.employeeId, me.cqid, `📊 ${built.poll.question}`))
  return { ok: true, data: { id: data.id } }
}

/** Set my vote. `optionIds` replaces whatever I chose before; empty removes my vote. */
export async function votePoll(messageId: string, optionIds: string[]): Promise<Result<PollData>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()
  const { data: msg } = await admin.from('messages')
    .select('id, conversation_id, metadata, deleted_at').eq('id', messageId).maybeSingle()
  if (!msg || msg.deleted_at) return { ok: false, error: 'Poll not found.' }
  const membership = await requireMembership(msg.conversation_id, me.employeeId)
  if (!membership.ok) return membership
  const poll = readPoll((msg.metadata as Record<string, unknown>) ?? {})
  if (!poll) return { ok: false, error: 'Poll not found.' }

  const valid = new Set(poll.options.map(o => o.id))
  let chosen = [...new Set(optionIds)].filter(id => valid.has(id))
  if (!poll.multi) chosen = chosen.slice(0, 1)

  const { error: delErr } = await admin.from('message_poll_votes').delete().eq('message_id', messageId).eq('employee_id', me.employeeId)
  if (delErr) return { ok: false, error: 'Polls need the chat upgrade migration.' }
  if (chosen.length) {
    const { error } = await admin.from('message_poll_votes')
      .insert(chosen.map(option_id => ({ message_id: messageId, employee_id: me.employeeId, option_id })))
    if (error) return { ok: false, error: error.message }
  }
  // Re-count from the votes table every time, so two people voting at once
  // can never leave a wrong total behind — the next count corrects it.
  const { data: rows } = await admin.from('message_poll_votes').select('employee_id, option_id').eq('message_id', messageId)
  const next: PollData = { ...poll, votes: tallyVotes(poll, (rows ?? []) as { employee_id: string; option_id: string }[]) }
  const { data: fresh } = await admin.from('messages').select('metadata').eq('id', messageId).maybeSingle()
  await admin.from('messages')
    .update({ metadata: { ...((fresh?.metadata as Record<string, unknown>) ?? {}), poll: next } })
    .eq('id', messageId)
  return { ok: true, data: next }
}

// ── Scheduled messages ────────────────────────────────────────────────────────

export interface ScheduledMessage { id: string; conversationId: string; body: string; sendAt: string }

export async function scheduleMessage(conversationId: string, body: string, sendAtIso: string): Promise<Result<ScheduledMessage>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  const membership = await requireMembership(conversationId, me.employeeId)
  if (!membership.ok) return membership
  const mayPost = await requireCanPost(me, conversationId, membership.role)
  if (!mayPost.ok) return mayPost
  const text = (body || '').trim()
  if (!text) return { ok: false, error: 'Message is empty.' }
  if (text.length > 8000) return { ok: false, error: 'Message is too long (8000 chars max).' }
  const at = new Date(sendAtIso).getTime()
  if (!Number.isFinite(at)) return { ok: false, error: 'Pick a date and time.' }
  if (at < Date.now() + 60_000) return { ok: false, error: 'Pick a time at least a minute from now.' }
  if (at > Date.now() + 366 * 86_400_000) return { ok: false, error: 'Pick a time within the next year.' }

  const { data, error } = await createAdminClient().from('chat_scheduled_messages')
    .insert({ conversation_id: conversationId, sender_id: me.employeeId, body: text, send_at: new Date(at).toISOString() })
    .select('id, conversation_id, body, send_at').single()
  if (error || !data) return { ok: false, error: error ? 'Scheduling needs the chat upgrade migration.' : 'Could not schedule.' }
  return { ok: true, data: { id: data.id, conversationId: data.conversation_id, body: data.body, sendAt: data.send_at } }
}

/** My messages still waiting to be sent, soonest first. */
export async function listScheduled(conversationId?: string): Promise<Result<ScheduledMessage[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  let q = createAdminClient().from('chat_scheduled_messages')
    .select('id, conversation_id, body, send_at')
    .eq('sender_id', auth.me.employeeId).is('sent_at', null).is('cancelled_at', null)
    .order('send_at', { ascending: true }).limit(50)
  if (conversationId) q = q.eq('conversation_id', conversationId)
  const { data, error } = await q
  if (error) return { ok: true, data: [] }
  return { ok: true, data: (data ?? []).map(r => ({ id: r.id, conversationId: r.conversation_id, body: r.body, sendAt: r.send_at })) }
}

export async function cancelScheduled(id: string): Promise<Result<null>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const { error } = await createAdminClient().from('chat_scheduled_messages')
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', id).eq('sender_id', auth.me.employeeId).is('sent_at', null)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

// ── My notes: a chat with only me in it ───────────────────────────────────────

/**
 * Open (or create) my own notes chat — a private room with one member, for
 * links, files and reminders to myself. It works like any other chat: search,
 * star, pin and forward all apply.
 */
export async function getOrCreateMyNotes(): Promise<Result<{ id: string }>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()
  const { data: existing } = await admin.from('conversations')
    .select('id, members:conversation_members!inner(employee_id)')
    .eq('category', 'self').eq('created_by', me.employeeId).is('archived_at', null)
    .eq('members.employee_id', me.employeeId)
    .limit(1)
  if (existing?.length) return { ok: true, data: { id: existing[0].id as string } }

  const { data: conv, error } = await admin.from('conversations')
    .insert({ type: 'group', name: 'My notes', topic: 'Only you can see this', is_private: true, category: 'self', created_by: me.employeeId })
    .select('id').single()
  if (error || !conv) return { ok: false, error: error?.message ?? 'Could not create your notes.' }
  const { error: memErr } = await admin.from('conversation_members')
    .insert({ conversation_id: conv.id, employee_id: me.employeeId, role: 'owner' })
  if (memErr) return { ok: false, error: memErr.message }
  return { ok: true, data: { id: conv.id as string } }
}

/** Departments as they are written in a mention: @social-media. */
export async function listMentionGroups(): Promise<Result<{ slug: string; name: string }[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const { data } = await createAdminClient().from('service_categories').select('name').order('name')
  return {
    ok: true,
    data: ((data ?? []) as { name: string }[]).map(d => ({ slug: departmentSlug(d.name), name: d.name })).filter(d => d.slug),
  }
}

// ── Departments, for a department channel ─────────────────────────────────────

/** Departments I can make a channel for: mine, or all of them for an admin. */
export async function listChatDepartments(): Promise<Result<{ id: string; name: string }[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const [{ data }, byEmployee] = await Promise.all([
    admin.from('service_categories').select('id, name').order('name'),
    auth.me.isAdmin ? Promise.resolve(null) : loadDepartmentsByEmployee(admin),
  ])
  const mine = byEmployee?.get(auth.me.employeeId)
  return { ok: true, data: ((data ?? []) as { id: string; name: string }[]).filter(d => !byEmployee || mine?.has(d.id)) }
}

// ── Admin: who may chat with whom ─────────────────────────────────────────────

export interface ChatAccessSettings {
  departments: { id: string; name: string }[]
  employees: { id: string; name: string; cqid: string; departmentIds: string[]; isAdmin: boolean }[]
  rules: ChatAccessRule[]
  /** False until the migration is applied — the page then says so instead of failing on save. */
  ready: boolean
}

export async function getChatAccessSettings(): Promise<Result<ChatAccessSettings>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  if (!auth.me.isAdmin) return { ok: false, error: 'Only an admin can manage chat access.' }
  const admin = createAdminClient()
  const [departments, employees, deptByEmp, rules, probe] = await Promise.all([
    admin.from('service_categories').select('id, name').order('name'),
    admin.from('employees').select('id, cqid, is_archived, designation:designation_id(is_admin)').order('cqid'),
    loadDepartmentsByEmployee(admin),
    loadChatAccessRules(admin),
    admin.from('chat_access_rules').select('id').limit(1),
  ])
  return {
    ok: true,
    data: {
      departments: ((departments.data ?? []) as { id: string; name: string }[]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      employees: ((employees.data ?? []) as any[]).filter(e => !e.is_archived).map(e => {
        const d = Array.isArray(e.designation) ? e.designation[0] : e.designation
        return { id: e.id, name: '', cqid: e.cqid ?? '', departmentIds: [...(deptByEmp.get(e.id) ?? [])], isAdmin: d?.is_admin === true }
      }),
      rules,
      ready: !probe.error,
    },
  }
}

const MODES: ChatAccessMode[] = ['everyone', 'own_department', 'custom', 'none']

export async function saveChatAccessRule(rule: ChatAccessRule): Promise<Result<null>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  const me = auth.me
  if (!me.isAdmin) return { ok: false, error: 'Only an admin can manage chat access.' }
  if (!['department', 'employee'].includes(rule.subjectType) || !rule.subjectId || !MODES.includes(rule.mode)) {
    return { ok: false, error: 'Invalid rule.' }
  }
  const custom = rule.mode === 'custom'
  const { error } = await createAdminClient().from('chat_access_rules').upsert({
    subject_type: rule.subjectType,
    subject_id: rule.subjectId,
    mode: rule.mode,
    department_ids: custom ? [...new Set(rule.departmentIds)] : [],
    employee_ids: custom ? [...new Set(rule.employeeIds)] : [],
    updated_by: me.employeeId,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'subject_type,subject_id' })
  if (error) return { ok: false, error: /chat_access_rules/.test(error.message) ? 'Chat access needs the chat upgrade migration.' : error.message }
  void logActivity({
    actorId: me.employeeId, entityType: 'message', entityId: rule.subjectId,
    action: 'updated', category: 'chat',
    detail: { label: `Chat access (${rule.subjectType}): ${rule.mode}` },
  })
  return { ok: true, data: null }
}

/** Remove a rule — the department or person goes back to the default. */
export async function removeChatAccessRule(subjectType: 'department' | 'employee', subjectId: string): Promise<Result<null>> {
  const auth = await requireChatUser(true)
  if (!auth.ok) return auth
  if (!auth.me.isAdmin) return { ok: false, error: 'Only an admin can manage chat access.' }
  const { error } = await createAdminClient().from('chat_access_rules')
    .delete().eq('subject_type', subjectType).eq('subject_id', subjectId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}
