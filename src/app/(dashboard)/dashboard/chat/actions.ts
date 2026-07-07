'use server'

/**
 * Chat Phase 1 server actions — Cirqle Connect.
 *
 * Pattern (matches the codebase): every mutation checks the caller via
 * loadCurrentUser()/hasPermission(), does the write with the admin client,
 * then fire-and-forget logs to the timeline. Reads verify membership first.
 *
 * Live delivery is NOT done here: browsers subscribe to Supabase Realtime
 * (postgres_changes on `messages`, authorized by the RLS in migration 015).
 *
 * Design: CHAT_MODULE_PLAN.md §3–6, docs/cirqle-connect/API_DESIGN.md.
 */

import { after } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import { createNotification } from '@/lib/notifications/create'
import { transcribeAudio } from '@/lib/ai/transcribe'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChatMember {
  employeeId: string
  name: string
  cqid: string
  role: 'owner' | 'moderator' | 'member'
}

export interface ChatConversation {
  id: string
  type: 'channel' | 'dm' | 'group' | 'project' | 'task' | 'client' | 'request'
  name: string | null          // resolved display name (DM = other person)
  topic: string | null
  isPrivate: boolean
  isMember: boolean
  unread: number
  /** Sidebar grouping: general | department | client | discussion (entity rooms) */
  category: string | null
  lastMessage: { body: string; senderName: string | null; senderCqid: string | null; createdAt: string } | null
  members: ChatMember[]
}

export interface ChatAttachment {
  id: string
  fileName: string
  mimeType: string | null
  sizeBytes: number | null
  /** Short-lived signed URL (60 min) — regenerate via getAttachmentUrl. */
  url: string | null
}

export interface ChatMessage {
  id: string
  conversationId: string
  senderId: string | null
  senderName: string | null
  senderCqid: string | null
  body: string
  kind: string
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  parentId: string | null
  metadata: Record<string, unknown>
  replyCount: number
  /** emoji → employee ids who reacted */
  reactions: Record<string, string[]>
  attachments: ChatAttachment[]
  /** Employee ids who read this message — populated ONLY on the caller's own
   *  messages (read receipts are sender-visible; SECURITY: stripped otherwise). */
  readerIds: string[]
  /** Employee ids who PLAYED this voice note — own voice messages only. */
  playedByIds: string[]
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

const MESSAGE_PAGE = 50

// ── Internal helpers ──────────────────────────────────────────────────────────

async function requireChatUser() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  if (!hasPermission(me, 'chat.access')) {
    return { ok: false as const, error: 'You do not have access to chat.' }
  }
  return { ok: true as const, me }
}

async function requireMembership(conversationId: string, employeeId: string) {
  const admin = createAdminClient()
  const { data } = await admin
    .from('conversation_members')
    .select('role')
    .eq('conversation_id', conversationId)
    .eq('employee_id', employeeId)
    .maybeSingle()
  return data ? { ok: true as const, role: data.role as ChatMember['role'] } :
                { ok: false as const, error: 'You are not a member of this conversation.' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapMessage(r: any): ChatMessage {
  const sender = Array.isArray(r.sender) ? r.sender[0] : r.sender
  return {
    id: r.id,
    conversationId: r.conversation_id,
    senderId: r.sender_id ?? null,
    senderName: sender?.name ?? null,
    senderCqid: sender?.cqid ?? null,
    body: r.deleted_at ? '' : (r.body ?? ''),
    kind: r.kind ?? 'text',
    createdAt: r.created_at,
    editedAt: r.edited_at ?? null,
    deletedAt: r.deleted_at ?? null,
    parentId: r.parent_id ?? null,
    metadata: r.metadata ?? {},
    replyCount: 0,
    reactions: {},
    attachments: [],
    readerIds: [],
    playedByIds: [],
  }
}

/**
 * Enrich a page of messages with reply counts, reactions and signed
 * attachment URLs (three bounded queries per page, not per message).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichMessages(admin: any, msgs: ChatMessage[], meId?: string): Promise<ChatMessage[]> {
  if (msgs.length === 0) return msgs
  const ids = msgs.map(m => m.id)
  // Read receipts are only ever attached to the caller's OWN messages.
  const ownIds = meId ? msgs.filter(m => m.senderId === meId).map(m => m.id) : []
  // Voice "played" receipts — own voice messages only (migration 021).
  const ownVoiceIds = meId ? msgs.filter(m => m.senderId === meId && m.kind === 'voice').map(m => m.id) : []
  // Quoted-reply targets: check which originals were deleted since.
  const replyTargetIds = [...new Set(msgs
    .map(m => (m.metadata as { replyTo?: { messageId?: string } }).replyTo?.messageId)
    .filter((x): x is string => typeof x === 'string'))]

  const [repliesRes, reactionsRes, attachRes, readsRes, replyTargetsRes, playsRes] = await Promise.all([
    admin.from('messages').select('parent_id').in('parent_id', ids).is('deleted_at', null),
    admin.from('message_reactions').select('message_id, employee_id, emoji').in('message_id', ids),
    admin.from('message_attachments').select('id, message_id, storage_path, file_name, mime_type, size_bytes').in('message_id', ids),
    ownIds.length
      ? admin.from('message_reads').select('message_id, employee_id').in('message_id', ownIds)
      : Promise.resolve({ data: [] }),
    replyTargetIds.length
      ? admin.from('messages').select('id, deleted_at').in('id', replyTargetIds)
      : Promise.resolve({ data: [] }),
    // Graceful pre-migration: swallow errors if message_plays (021) not applied.
    ownVoiceIds.length
      ? admin.from('message_plays').select('message_id, employee_id').in('message_id', ownVoiceIds).then(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (r: any) => (r.error ? { data: [] } : r))
      : Promise.resolve({ data: [] }),
  ])

  const replyCount = new Map<string, number>()
  for (const r of repliesRes.data ?? []) {
    replyCount.set(r.parent_id, (replyCount.get(r.parent_id) ?? 0) + 1)
  }

  const reactions = new Map<string, Record<string, string[]>>()
  for (const r of reactionsRes.data ?? []) {
    const byEmoji = reactions.get(r.message_id) ?? {}
    ;(byEmoji[r.emoji] ??= []).push(r.employee_id)
    reactions.set(r.message_id, byEmoji)
  }

  const attachments = new Map<string, ChatAttachment[]>()
  await Promise.all((attachRes.data ?? []).map(async (a: {
    id: string; message_id: string; storage_path: string
    file_name: string; mime_type: string | null; size_bytes: number | null
  }) => {
    const { data: signed } = await admin.storage
      .from('chat-attachments')
      .createSignedUrl(a.storage_path, 3600)
    const list = attachments.get(a.message_id) ?? []
    list.push({
      id: a.id, fileName: a.file_name, mimeType: a.mime_type,
      sizeBytes: a.size_bytes, url: signed?.signedUrl ?? null,
    })
    attachments.set(a.message_id, list)
  }))

  const readers = new Map<string, string[]>()
  for (const r of ('data' in readsRes ? readsRes.data : []) ?? []) {
    if (!readers.has(r.message_id)) readers.set(r.message_id, [])
    readers.get(r.message_id)!.push(r.employee_id)
  }

  const players = new Map<string, string[]>()
  for (const r of ('data' in playsRes ? playsRes.data : []) ?? []) {
    if (!players.has(r.message_id)) players.set(r.message_id, [])
    players.get(r.message_id)!.push(r.employee_id)
  }

  const deletedTargets = new Set(
    ((('data' in replyTargetsRes ? replyTargetsRes.data : []) ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((t: any) => t.deleted_at)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((t: any) => t.id)),
  )
  const existingTargets = new Set(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((('data' in replyTargetsRes ? replyTargetsRes.data : []) ?? []).map((t: any) => t.id)),
  )

  return msgs.map(m => {
    const replyToId = (m.metadata as { replyTo?: { messageId?: string } }).replyTo?.messageId
    const replyToUnavailable = typeof replyToId === 'string' &&
      (deletedTargets.has(replyToId) || !existingTargets.has(replyToId))
    return {
      ...m,
      metadata: replyToUnavailable ? { ...m.metadata, replyToUnavailable: true } : m.metadata,
      replyCount: replyCount.get(m.id) ?? 0,
      reactions: reactions.get(m.id) ?? {},
      attachments: attachments.get(m.id) ?? [],
      readerIds: readers.get(m.id) ?? [],
      playedByIds: players.get(m.id) ?? [],
    }
  })
}

// ── Quoted replies (WhatsApp-style, Wave C+) ─────────────────────────────────
// A quote reply is a normal message whose metadata.replyTo carries a SNAPSHOT
// of the original (sender, kind, preview, mini-peaks) — bubbles render without
// joins; availability is re-checked in enrichMessages. Distinct from threads:
// parent_id keeps powering the thread panel, replies stay in the main flow.

export interface ReplySnapshot {
  messageId: string
  senderId: string | null
  senderName: string
  senderCqid: string
  kind: string
  preview: string          // body / transcript / file name snippet
  durationMs?: number      // voice originals
  peaks?: number[]         // 12-bar mini waveform for voice originals
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildReplySnapshot(admin: any, replyToId: string, conversationId: string): Promise<ReplySnapshot | null> {
  const { data: t } = await admin
    .from('messages')
    .select('id, conversation_id, sender_id, body, kind, metadata, deleted_at, sender:sender_id(name, cqid)')
    .eq('id', replyToId).maybeSingle()
  if (!t || t.conversation_id !== conversationId || t.deleted_at) return null
  const sender = Array.isArray(t.sender) ? t.sender[0] : t.sender
  const meta = (t.metadata ?? {}) as { durationMs?: number; peaks?: number[]; transcript?: string | null }
  let preview = (t.body || '').slice(0, 90)
  if (t.kind === 'voice') preview = (meta.transcript || 'Voice message').slice(0, 90)
  if (t.kind === 'file' && !preview) preview = 'File'
  const fullPeaks = Array.isArray(meta.peaks) ? meta.peaks : []
  // Downsample 64 → 12 bars for the compact preview
  const peaks = fullPeaks.length
    ? Array.from({ length: 12 }, (_, i) => fullPeaks[Math.floor((i / 12) * fullPeaks.length)] ?? 0)
    : undefined
  return {
    messageId: t.id,
    senderId: t.sender_id ?? null,
    senderName: sender?.name ?? sender?.cqid ?? 'Someone',
    senderCqid: sender?.cqid ?? '',
    kind: t.kind ?? 'text',
    preview,
    durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : undefined,
    peaks,
  }
}

/** Shared post-send hooks for quote replies: notify original sender + timeline. */
function afterReplyHooks(me: { employeeId: string; name: string; cqid: string }, snapshot: ReplySnapshot, conversationId: string, newMessageId: string): void {
  if (snapshot.senderId && snapshot.senderId !== me.employeeId) {
    void createNotification({
      employeeId: snapshot.senderId,
      type: 'chat_reply',
      title: `${me.name || me.cqid} replied to your ${snapshot.kind === 'voice' ? 'voice message' : 'message'}`,
      message: snapshot.preview || undefined,
      link: `/dashboard/chat?c=${conversationId}`,
      sourceKey: `chat_reply:${newMessageId}`,
    })
  }
  void logActivity({
    actorId: me.employeeId, entityType: 'message', entityId: newMessageId,
    action: 'replied', category: 'chat', conversationId,
    detail: { label: snapshot.kind === 'voice' ? 'voice message' : snapshot.preview.slice(0, 40) },
  })
}

// ── Mentions ─────────────────────────────────────────────────────────────────
// Syntax: @Full Name or @CQID — resolved against conversation members only
// (you can't ping someone who can't read the message). Parsed server-side so
// notifications can't be forged for arbitrary employees.

function extractMentions(
  body: string,
  members: { employeeId: string; name: string; cqid: string }[],
  senderId: string,
): string[] {
  if (!body.includes('@')) return []
  const lower = body.toLowerCase()
  const hit = new Set<string>()
  for (const m of members) {
    if (m.employeeId === senderId) continue
    const name = (m.name || '').toLowerCase()
    const cqid = (m.cqid || '').toLowerCase()
    if ((name && lower.includes(`@${name}`)) || (cqid && lower.includes(`@${cqid}`))) {
      hit.add(m.employeeId)
    }
  }
  if (lower.includes('@everyone') || lower.includes('@channel')) {
    members.forEach(m => { if (m.employeeId !== senderId) hit.add(m.employeeId) })
  }
  return [...hit]
}

// ── Conversations ─────────────────────────────────────────────────────────────

/** All conversations for the sidebar: memberships + joinable public channels. */
export async function listConversations(): Promise<Result<ChatConversation[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  // Memberships (with per-conversation last_read_at)
  const { data: memberships, error: memErr } = await admin
    .from('conversation_members')
    .select('conversation_id, last_read_at')
    .eq('employee_id', me.employeeId)
  if (memErr) {
    // Table missing → migration 015 not applied
    return { ok: false, error: 'Chat is not set up yet — apply migration 015_chat_module.sql.' }
  }
  const lastReadByConv = new Map((memberships ?? []).map(m => [m.conversation_id, m.last_read_at]))
  const memberIds = [...lastReadByConv.keys()]

  // My conversations + public channels I could join
  const orFilter = memberIds.length
    ? `id.in.(${memberIds.join(',')}),and(type.eq.channel,is_private.eq.false)`
    : 'and(type.eq.channel,is_private.eq.false)'
  const { data: convs, error: convErr } = await admin
    .from('conversations')
    .select(`
      id, type, name, topic, is_private, category, created_at, archived_at,
      members:conversation_members(employee_id, role, employee:employee_id(id, name, cqid))
    `)
    .or(orFilter)
    .is('archived_at', null)
  if (convErr) return { ok: false, error: convErr.message }

  // Last message + unread count per conversation (bounded parallel queries —
  // fine at team scale; swap for an RPC when conversations grow past ~50).
  const results = await Promise.all((convs ?? []).map(async (c) => {
    const isMember = lastReadByConv.has(c.id)
    const [lastRes, unreadRes] = await Promise.all([
      admin.from('messages')
        .select('body, kind, deleted_at, created_at, sender:sender_id(name)')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: false })
        .limit(1).maybeSingle(),
      isMember
        ? admin.from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', c.id)
            .gt('created_at', lastReadByConv.get(c.id) as string)
            .neq('sender_id', me.employeeId)
            .is('deleted_at', null)
        : Promise.resolve({ count: 0 }),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const members: ChatMember[] = ((c as any).members ?? []).map((m: any) => {
      const emp = Array.isArray(m.employee) ? m.employee[0] : m.employee
      return { employeeId: m.employee_id, role: m.role, name: emp?.name ?? '', cqid: emp?.cqid ?? '' }
    })

    // DM display: keep BOTH name and cqid — the client masks per privacy rules.
    let name = c.name
    if (c.type === 'dm') {
      const other = members.find(m => m.employeeId !== me.employeeId)
      name = other ? `${other.cqid}||${other.name}` : 'Direct message' // client splits + masks
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const last: any = (lastRes as any)?.data ?? null
    const lastSender = last ? (Array.isArray(last.sender) ? last.sender[0] : last.sender) : null

    // Entity rooms group under "Discussions" in the sidebar.
    const category = ['task', 'project', 'request', 'client'].includes(c.type)
      ? 'discussion'
      : (c.category ?? 'general')

    return {
      id: c.id,
      type: c.type,
      name,
      topic: c.topic ?? null,
      isPrivate: c.is_private,
      isMember,
      unread: ('count' in unreadRes ? unreadRes.count : 0) ?? 0,
      category,
      lastMessage: last ? {
        body: last.deleted_at ? 'Message deleted' : (last.kind === 'text' ? last.body : `[${last.kind}]`),
        senderName: lastSender?.name ?? null,
        senderCqid: lastSender?.cqid ?? null,
        createdAt: last.created_at,
      } : null,
      members,
    } satisfies ChatConversation
  }))

  // Sort: unread first, then most recent activity
  results.sort((a, b) => {
    const at = a.lastMessage?.createdAt ?? '', bt = b.lastMessage?.createdAt ?? ''
    return bt.localeCompare(at)
  })
  return { ok: true, data: results }
}

/** Create a channel or group. Creator becomes owner. */
export async function createChannel(input: {
  name: string
  topic?: string
  isPrivate?: boolean
  memberIds?: string[]
  type?: 'channel' | 'group'
  /** Sidebar group: general (default) | department | client */
  category?: 'general' | 'department' | 'client'
  /** For client channels: links the conversation to the CRM client */
  clientId?: string | null
}): Promise<Result<{ id: string }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  if (!hasPermission(me, 'chat.create_channels')) {
    return { ok: false, error: 'You do not have permission to create channels.' }
  }
  const name = (input.name || '').trim().replace(/^#/, '')
  if (!name) return { ok: false, error: 'Channel name is required.' }

  const admin = createAdminClient()
  const insertRow: Record<string, unknown> = {
    type: input.type ?? 'channel',
    name,
    topic: (input.topic || '').trim() || null,
    is_private: input.isPrivate ?? false,
    created_by: me.employeeId,
    category: input.category ?? 'general',
    client_id: input.clientId ?? null,
  }
  let res = await admin.from('conversations').insert(insertRow).select('id').single()
  // Migration 019 not applied → retry without the new column
  if (res.error && /category/.test(res.error.message)) {
    delete insertRow.category
    res = await admin.from('conversations').insert(insertRow).select('id').single()
  }
  if (res.error || !res.data) return { ok: false, error: res.error?.message ?? 'Insert failed' }
  const convId = res.data.id as string

  const memberRows = [
    { conversation_id: convId, employee_id: me.employeeId, role: 'owner' },
    ...(input.memberIds ?? [])
      .filter(id => id !== me.employeeId)
      .map(id => ({ conversation_id: convId, employee_id: id, role: 'member' })),
  ]
  const { error: memErr } = await admin.from('conversation_members').insert(memberRows)
  if (memErr) return { ok: false, error: memErr.message }

  void logActivity({
    actorId: me.employeeId, entityType: 'message', entityId: convId,
    action: 'created', category: 'chat', conversationId: convId,
    detail: { label: `#${name}` },
  })
  return { ok: true, data: { id: convId } }
}

/** Open (or create) the 1:1 DM with another employee. */
export async function getOrCreateDm(otherEmployeeId: string): Promise<Result<{ id: string }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  if (!otherEmployeeId || otherEmployeeId === me.employeeId) {
    return { ok: false, error: 'Pick another person to message.' }
  }
  const admin = createAdminClient()

  // Existing DM = a type='dm' conversation whose member set is exactly {me, other}
  const { data: myDms } = await admin
    .from('conversation_members')
    .select('conversation_id, conversation:conversation_id(type)')
    .eq('employee_id', me.employeeId)
  const dmIds = (myDms ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r: any) => (Array.isArray(r.conversation) ? r.conversation[0] : r.conversation)?.type === 'dm')
    .map(r => r.conversation_id)
  if (dmIds.length) {
    const { data: shared } = await admin
      .from('conversation_members')
      .select('conversation_id')
      .in('conversation_id', dmIds)
      .eq('employee_id', otherEmployeeId)
      .limit(1)
    if (shared?.length) return { ok: true, data: { id: shared[0].conversation_id } }
  }

  const { data: conv, error } = await admin
    .from('conversations')
    .insert({ type: 'dm', is_private: true, created_by: me.employeeId })
    .select('id').single()
  if (error) return { ok: false, error: error.message }
  const { error: memErr } = await admin.from('conversation_members').insert([
    { conversation_id: conv.id, employee_id: me.employeeId, role: 'member' },
    { conversation_id: conv.id, employee_id: otherEmployeeId, role: 'member' },
  ])
  if (memErr) return { ok: false, error: memErr.message }
  return { ok: true, data: { id: conv.id } }
}

/** Join a public channel. */
export async function joinChannel(conversationId: string): Promise<Result<null>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  const { data: conv } = await admin
    .from('conversations')
    .select('id, type, is_private')
    .eq('id', conversationId).maybeSingle()
  if (!conv) return { ok: false, error: 'Conversation not found.' }
  if (conv.type !== 'channel' || conv.is_private) {
    return { ok: false, error: 'This conversation is invite-only.' }
  }
  const { error } = await admin.from('conversation_members')
    .upsert({ conversation_id: conversationId, employee_id: me.employeeId, role: 'member' },
            { onConflict: 'conversation_id,employee_id' })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

/** Employees available for DMs / channel invites (active only, minimal fields). */
export async function listChatEmployees(): Promise<Result<{ id: string; name: string; cqid: string }[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('employees')
    .select('id, name, cqid, is_archived')
    .or('is_archived.is.null,is_archived.eq.false')
    .order('name')
  if (error) return { ok: false, error: error.message }
  return {
    ok: true,
    data: (data ?? [])
      .filter(e => e.id !== auth.me.employeeId)
      .map(e => ({ id: e.id, name: e.name ?? '', cqid: e.cqid ?? '' })),
  }
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function getMessages(
  conversationId: string,
  cursor?: string | null,
): Promise<Result<{ messages: ChatMessage[]; nextCursor: string | null }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const membership = await requireMembership(conversationId, auth.me.employeeId)
  if (!membership.ok) return membership

  const admin = createAdminClient()
  let q = admin
    .from('messages')
    .select('id, conversation_id, sender_id, parent_id, body, kind, metadata, edited_at, deleted_at, created_at, sender:sender_id(name, cqid)')
    .eq('conversation_id', conversationId)
    .is('parent_id', null) // thread replies load via getThread
    .order('created_at', { ascending: false })
    .limit(MESSAGE_PAGE + 1)
  if (cursor) q = q.lt('created_at', cursor)

  const { data, error } = await q
  if (error) return { ok: false, error: error.message }

  const rows = data ?? []
  const hasMore = rows.length > MESSAGE_PAGE
  const page = hasMore ? rows.slice(0, MESSAGE_PAGE) : rows
  const enriched = await enrichMessages(admin, page.map(mapMessage), auth.me.employeeId)
  return {
    ok: true,
    data: {
      messages: enriched.reverse(), // oldest-first for rendering
      nextCursor: hasMore ? page[page.length - 1].created_at : null,
    },
  }
}

/** A thread: the parent message + all its replies (oldest-first). */
export async function getThread(parentId: string): Promise<Result<{ parent: ChatMessage; replies: ChatMessage[] }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()

  const { data: parentRow, error: pErr } = await admin
    .from('messages')
    .select('id, conversation_id, sender_id, parent_id, body, kind, metadata, edited_at, deleted_at, created_at, sender:sender_id(name, cqid)')
    .eq('id', parentId).maybeSingle()
  if (pErr || !parentRow) return { ok: false, error: 'Message not found.' }

  const membership = await requireMembership(parentRow.conversation_id, auth.me.employeeId)
  if (!membership.ok) return membership

  const { data: replyRows, error: rErr } = await admin
    .from('messages')
    .select('id, conversation_id, sender_id, parent_id, body, kind, metadata, edited_at, deleted_at, created_at, sender:sender_id(name, cqid)')
    .eq('parent_id', parentId)
    .order('created_at', { ascending: true })
    .limit(200)
  if (rErr) return { ok: false, error: rErr.message }

  const [parent] = await enrichMessages(admin, [mapMessage(parentRow)], auth.me.employeeId)
  const replies  = await enrichMessages(admin, (replyRows ?? []).map(mapMessage), auth.me.employeeId)
  return { ok: true, data: { parent, replies } }
}

export async function sendMessage(
  conversationId: string,
  body: string,
  opts?: { parentId?: string | null; replyToId?: string | null },
): Promise<Result<ChatMessage>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const membership = await requireMembership(conversationId, me.employeeId)
  if (!membership.ok) return membership

  const text = (body || '').trim()
  if (!text) return { ok: false, error: 'Message is empty.' }
  if (text.length > 8000) return { ok: false, error: 'Message is too long (8000 chars max).' }

  const admin = createAdminClient()

  // Threads: parent must exist in the SAME conversation and be a root message.
  let parentId: string | null = null
  if (opts?.parentId) {
    const { data: parent } = await admin
      .from('messages')
      .select('id, conversation_id, parent_id')
      .eq('id', opts.parentId).maybeSingle()
    if (!parent || parent.conversation_id !== conversationId) {
      return { ok: false, error: 'Thread parent not found in this conversation.' }
    }
    parentId = parent.parent_id ?? parent.id // replying to a reply nests under the root
  }

  // Mentions: resolved against members server-side (can't ping non-members).
  const { data: memberRows } = await admin
    .from('conversation_members')
    .select('employee_id, notify_level, employee:employee_id(name, cqid)')
    .eq('conversation_id', conversationId)
  const members = (memberRows ?? []).map((m) => {
    const emp = Array.isArray(m.employee) ? m.employee[0] : m.employee
    return {
      employeeId: m.employee_id as string,
      notifyLevel: (m.notify_level as string) ?? 'all',
      name: (emp as { name?: string } | null)?.name ?? '',
      cqid: (emp as { cqid?: string } | null)?.cqid ?? '',
    }
  })
  const mentionIds = extractMentions(text, members, me.employeeId)

  // Quoted reply (WhatsApp-style): snapshot the original into metadata.
  let replySnapshot: ReplySnapshot | null = null
  if (opts?.replyToId) {
    replySnapshot = await buildReplySnapshot(admin, opts.replyToId, conversationId)
    if (!replySnapshot) return { ok: false, error: 'The message you are replying to is unavailable.' }
  }

  const metadata: Record<string, unknown> = {}
  if (mentionIds.length) metadata.mentions = mentionIds
  if (replySnapshot) metadata.replyTo = replySnapshot

  const { data, error } = await admin
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_id: me.employeeId,
      parent_id: parentId,
      body: text,
      kind: 'text',
      metadata,
    })
    .select('id, conversation_id, sender_id, parent_id, body, kind, metadata, edited_at, deleted_at, created_at')
    .single()
  if (error) return { ok: false, error: error.message }

  // Sending also reads: bump my last_read_at so my own message isn't "unread".
  void admin.from('conversation_members')
    .update({ last_read_at: data.created_at })
    .eq('conversation_id', conversationId)
    .eq('employee_id', me.employeeId)
    .then(undefined, () => {})

  // Mention notifications (idempotent per message+mention via source_key;
  // respects each member's notify_level).
  for (const empId of mentionIds) {
    const member = members.find(m => m.employeeId === empId)
    if (!member || member.notifyLevel === 'none') continue
    void createNotification({
      employeeId: empId,
      type: 'chat_mention',
      title: `${me.name || me.cqid} mentioned you`,
      message: text.length > 120 ? `${text.slice(0, 120)}…` : text,
      link: `/dashboard/chat?c=${conversationId}`,
      sourceKey: `chat_mention:${data.id}:${empId}`,
    })
  }

  if (replySnapshot) afterReplyHooks(me, replySnapshot, conversationId, data.id)

  return {
    ok: true,
    data: { ...mapMessage(data), senderName: me.name, senderCqid: me.cqid },
  }
}

/** Toggle an emoji reaction on a message (add if absent, remove if present). */
export async function toggleReaction(messageId: string, emoji: string): Promise<Result<null>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  if (!emoji || emoji.length > 16) return { ok: false, error: 'Invalid reaction.' }

  const admin = createAdminClient()
  const { data: msg } = await admin
    .from('messages').select('id, conversation_id').eq('id', messageId).maybeSingle()
  if (!msg) return { ok: false, error: 'Message not found.' }
  const membership = await requireMembership(msg.conversation_id, me.employeeId)
  if (!membership.ok) return membership

  const { data: existing } = await admin
    .from('message_reactions')
    .select('message_id')
    .eq('message_id', messageId).eq('employee_id', me.employeeId).eq('emoji', emoji)
    .maybeSingle()

  const { error } = existing
    ? await admin.from('message_reactions').delete()
        .eq('message_id', messageId).eq('employee_id', me.employeeId).eq('emoji', emoji)
    : await admin.from('message_reactions').insert({
        message_id: messageId, employee_id: me.employeeId, emoji,
      })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

// ── Attachments ───────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 10 * 1024 * 1024 // mirrors the bucket limit (migration 016)

/** Step 1: get a signed upload URL (path is server-generated). */
export async function createAttachmentUploadUrl(input: {
  conversationId: string
  fileName: string
  sizeBytes: number
}): Promise<Result<{ signedUrl: string; token: string; storagePath: string }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const membership = await requireMembership(input.conversationId, auth.me.employeeId)
  if (!membership.ok) return membership
  if (input.sizeBytes > MAX_FILE_BYTES) return { ok: false, error: 'File is larger than 10 MB.' }

  const safeName = (input.fileName || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120)
  const storagePath = `${input.conversationId}/${crypto.randomUUID()}/${safeName}`

  const admin = createAdminClient()
  const { data, error } = await admin.storage
    .from('chat-attachments')
    .createSignedUploadUrl(storagePath)
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create upload URL.' }
  return { ok: true, data: { signedUrl: data.signedUrl, token: data.token, storagePath } }
}

/** Step 2: after the browser uploads, create the file message + attachment row. */
export async function sendFileMessage(input: {
  conversationId: string
  storagePath: string
  fileName: string
  mimeType: string | null
  sizeBytes: number
  caption?: string
}): Promise<Result<ChatMessage>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const membership = await requireMembership(input.conversationId, me.employeeId)
  if (!membership.ok) return membership

  // The path must be one we generated for THIS conversation, and must exist.
  if (!input.storagePath.startsWith(`${input.conversationId}/`)) {
    return { ok: false, error: 'Invalid attachment path.' }
  }
  const admin = createAdminClient()
  const folder = input.storagePath.split('/').slice(0, -1).join('/')
  const leaf   = input.storagePath.split('/').pop() as string
  const { data: objects } = await admin.storage.from('chat-attachments').list(folder)
  const obj = (objects ?? []).find(o => o.name === leaf)
  if (!obj) return { ok: false, error: 'Upload not found — try again.' }

  const { data: msg, error: msgErr } = await admin
    .from('messages')
    .insert({
      conversation_id: input.conversationId,
      sender_id: me.employeeId,
      body: (input.caption || '').trim(),
      kind: 'file',
    })
    .select('id, conversation_id, sender_id, parent_id, body, kind, metadata, edited_at, deleted_at, created_at')
    .single()
  if (msgErr) return { ok: false, error: msgErr.message }

  const { error: attErr } = await admin.from('message_attachments').insert({
    message_id: msg.id,
    storage_path: input.storagePath,
    file_name: input.fileName,
    mime_type: input.mimeType,
    size_bytes: input.sizeBytes,
  })
  if (attErr) return { ok: false, error: attErr.message }

  void admin.from('conversation_members')
    .update({ last_read_at: msg.created_at })
    .eq('conversation_id', input.conversationId)
    .eq('employee_id', me.employeeId)
    .then(undefined, () => {})

  const [enriched] = await enrichMessages(admin, [mapMessage(msg)], me.employeeId)
  return { ok: true, data: { ...enriched, senderName: me.name, senderCqid: me.cqid } }
}

/** Fresh signed URL for one attachment (membership-checked). */
export async function getAttachmentUrl(attachmentId: string): Promise<Result<{ url: string }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const { data: att } = await admin
    .from('message_attachments')
    .select('storage_path, message:message_id(conversation_id)')
    .eq('id', attachmentId).maybeSingle()
  if (!att) return { ok: false, error: 'Attachment not found.' }
  const msg = Array.isArray(att.message) ? att.message[0] : att.message
  const membership = await requireMembership(
    (msg as { conversation_id: string }).conversation_id, auth.me.employeeId)
  if (!membership.ok) return membership

  const { data: signed, error } = await admin.storage
    .from('chat-attachments')
    .createSignedUrl(att.storage_path, 3600)
  if (error || !signed) return { ok: false, error: error?.message ?? 'Could not sign URL.' }
  return { ok: true, data: { url: signed.signedUrl } }
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface ChatSearchHit {
  messageId: string
  conversationId: string
  conversationName: string | null
  senderName: string | null
  senderCqid: string | null
  snippet: string
  createdAt: string
}

/** Full-text search across MY conversations only (membership-scoped). */
export async function searchMessages(query: string): Promise<Result<ChatSearchHit[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const q = (query || '').trim()
  if (q.length < 2) return { ok: true, data: [] }

  const admin = createAdminClient()
  const { data: memberships } = await admin
    .from('conversation_members')
    .select('conversation_id')
    .eq('employee_id', auth.me.employeeId)
  const convIds = (memberships ?? []).map(m => m.conversation_id)
  if (convIds.length === 0) return { ok: true, data: [] }

  const { data, error } = await admin
    .from('messages')
    .select('id, conversation_id, body, created_at, sender:sender_id(name, cqid), conversation:conversation_id(name, type)')
    .in('conversation_id', convIds)
    .is('deleted_at', null)
    .textSearch('body_search', q, { type: 'websearch', config: 'english' })
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) return { ok: false, error: error.message }

  return {
    ok: true,
    data: (data ?? []).map((r) => {
      const sender = Array.isArray(r.sender) ? r.sender[0] : r.sender
      const conv   = Array.isArray(r.conversation) ? r.conversation[0] : r.conversation
      const body: string = r.body ?? ''
      return {
        messageId: r.id,
        conversationId: r.conversation_id,
        conversationName: (conv as { name?: string } | null)?.name ?? null,
        senderName: (sender as { name?: string } | null)?.name ?? null,
        senderCqid: (sender as { cqid?: string } | null)?.cqid ?? null,
        snippet: body.length > 140 ? `${body.slice(0, 140)}…` : body,
        createdAt: r.created_at,
      }
    }),
  }
}

/** Soft-delete own message (moderators: any message). */
export async function deleteMessage(messageId: string): Promise<Result<null>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  const { data: msg } = await admin
    .from('messages')
    .select('id, sender_id, conversation_id, deleted_at')
    .eq('id', messageId).maybeSingle()
  if (!msg) return { ok: false, error: 'Message not found.' }
  if (msg.deleted_at) return { ok: true, data: null }

  const canModerate = me.isAdmin || hasPermission(me, 'chat.moderate')
  if (msg.sender_id !== me.employeeId && !canModerate) {
    return { ok: false, error: 'You can only delete your own messages.' }
  }
  const { error } = await admin
    .from('messages')
    .update({ deleted_at: new Date().toISOString(), body: '' })
    .eq('id', messageId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

/** Edit a text message's body. Own messages only (moderators cannot rewrite
 *  someone's words — deletion is the moderation tool). Voice/approval/file
 *  cards aren't editable. The realtime UPDATE handler propagates body +
 *  edited_at to open clients for free. */
export async function editMessage(messageId: string, body: string): Promise<Result<null>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const text = (body || '').trim()
  if (!text) return { ok: false, error: 'Message cannot be empty.' }
  if (text.length > 4000) return { ok: false, error: 'Message is too long.' }

  const admin = createAdminClient()
  const { data: msg } = await admin
    .from('messages')
    .select('id, sender_id, kind, deleted_at')
    .eq('id', messageId).maybeSingle()
  if (!msg) return { ok: false, error: 'Message not found.' }
  if (msg.deleted_at) return { ok: false, error: 'Cannot edit a deleted message.' }
  if (msg.sender_id !== me.employeeId) return { ok: false, error: 'You can only edit your own messages.' }
  if (msg.kind !== 'text') return { ok: false, error: 'Only text messages can be edited.' }

  const { error } = await admin
    .from('messages')
    .update({ body: text, edited_at: new Date().toISOString() })
    .eq('id', messageId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

/** Record that the caller played a voice note (idempotent, first play only).
 *  The sender sees a "played" tick via the message_plays realtime publication.
 *  Graceful pre-migration: swallows the error if migration 021 isn't applied. */
export async function markVoicePlayed(messageId: string): Promise<Result<null>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  const { data: msg } = await admin
    .from('messages')
    .select('id, sender_id, conversation_id, kind')
    .eq('id', messageId).maybeSingle()
  if (!msg || msg.kind !== 'voice') return { ok: true, data: null } // nothing to record
  if (msg.sender_id === me.employeeId) return { ok: true, data: null } // don't record own plays

  const membership = await requireMembership(msg.conversation_id, me.employeeId)
  if (!membership.ok) return membership

  try {
    await admin.from('message_plays').upsert(
      { message_id: messageId, employee_id: me.employeeId, conversation_id: msg.conversation_id },
      { onConflict: 'message_id,employee_id', ignoreDuplicates: true },
    )
  } catch { /* migration 021 not applied yet */ }
  return { ok: true, data: null }
}

/** Mark a conversation read up to now.
 *  Also writes normalized per-message receipts (migration 018) — the upsert
 *  is idempotent, so re-opening after being offline back-fills anything
 *  missed (reconnect/offline sync comes free). */
export async function markRead(conversationId: string): Promise<Result<null>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const membership = await requireMembership(conversationId, me.employeeId)
  if (!membership.ok) return membership

  const admin = createAdminClient()
  const { error } = await admin
    .from('conversation_members')
    .update({ last_read_at: new Date().toISOString() })
    .eq('conversation_id', conversationId)
    .eq('employee_id', me.employeeId)
  if (error) return { ok: false, error: error.message }

  // Per-message receipts: everything from others I haven't receipted yet.
  // Bounded to the latest 200 unreceipted messages per call; graceful when
  // migration 018 is not applied (error swallowed — last_read_at still works).
  try {
    const { data: unread } = await admin
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .neq('sender_id', me.employeeId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200)
    if (unread?.length) {
      await admin.from('message_reads').upsert(
        unread.map(m => ({
          message_id: m.id,
          employee_id: me.employeeId,
          conversation_id: conversationId,
        })),
        { onConflict: 'message_id,employee_id', ignoreDuplicates: true },
      )
    }
  } catch { /* migration 018 not applied yet */ }

  return { ok: true, data: null }
}

// ── Read receipts (Wave C+) ───────────────────────────────────────────────────

export interface ReadReceiptDetail {
  readers: { employeeId: string; name: string; cqid: string; designation: string | null; readAt: string }[]
  unread:  { employeeId: string; name: string; cqid: string; designation: string | null }[]
}

/** Detailed receipt list for ONE message — the SENDER only (privacy rule). */
export async function getReadReceipts(messageId: string): Promise<Result<ReadReceiptDetail>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()

  const { data: msg } = await admin
    .from('messages')
    .select('id, sender_id, conversation_id')
    .eq('id', messageId).maybeSingle()
  if (!msg) return { ok: false, error: 'Message not found.' }
  if (msg.sender_id !== me.employeeId) {
    return { ok: false, error: 'Only the sender can view read receipts.' }
  }

  const [{ data: reads }, { data: members }] = await Promise.all([
    admin.from('message_reads')
      .select('employee_id, read_at, employee:employee_id(name, cqid, designation:designation_id(name))')
      .eq('message_id', messageId)
      .order('read_at', { ascending: true }),
    admin.from('conversation_members')
      .select('employee_id, employee:employee_id(name, cqid, designation:designation_id(name))')
      .eq('conversation_id', msg.conversation_id),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unwrap = (e: any) => {
    const emp = Array.isArray(e) ? e[0] : e
    const des = emp?.designation ? (Array.isArray(emp.designation) ? emp.designation[0] : emp.designation) : null
    return { name: emp?.name ?? '', cqid: emp?.cqid ?? '', designation: des?.name ?? null }
  }

  const readIds = new Set((reads ?? []).map(r => r.employee_id))
  return {
    ok: true,
    data: {
      readers: (reads ?? []).map(r => ({
        employeeId: r.employee_id,
        readAt: r.read_at,
        ...unwrap(r.employee),
      })),
      unread: (members ?? [])
        .filter(m => m.employee_id !== me.employeeId && !readIds.has(m.employee_id))
        .map(m => ({ employeeId: m.employee_id, ...unwrap(m.employee) })),
    },
  }
}

// ── Voice notes (Wave C) ──────────────────────────────────────────────────────
// A voice note = a kind='voice' message + one attachment in chat-attachments
// (same bucket + signed-URL flow as files) + metadata { durationMs, peaks,
// transcript, transcriptStatus }. Transcription runs post-response via
// next/server after() — free Groq Whisper; failure leaves the note playable.

const MAX_VOICE_MS = 5 * 60 * 1000 // 5 minutes

export async function sendVoiceMessage(input: {
  conversationId: string
  storagePath: string
  durationMs: number
  peaks: number[]
  mimeType?: string
  sizeBytes: number
  replyToId?: string | null
}): Promise<Result<ChatMessage>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const membership = await requireMembership(input.conversationId, me.employeeId)
  if (!membership.ok) return membership

  if (input.durationMs > MAX_VOICE_MS) return { ok: false, error: 'Voice notes are limited to 5 minutes.' }
  if (!input.storagePath.startsWith(`${input.conversationId}/`)) {
    return { ok: false, error: 'Invalid attachment path.' }
  }

  const admin = createAdminClient()
  const folder = input.storagePath.split('/').slice(0, -1).join('/')
  const leaf   = input.storagePath.split('/').pop() as string
  const { data: objects } = await admin.storage.from('chat-attachments').list(folder)
  if (!(objects ?? []).some(o => o.name === leaf)) {
    return { ok: false, error: 'Upload not found — try again.' }
  }

  // 64 sanitized peaks (0..1) for instant waveform rendering
  const peaks = (input.peaks ?? []).slice(0, 64).map(p =>
    Math.max(0, Math.min(1, Number(p) || 0)))

  // Quoted reply support: voice→voice, voice→text, voice→file all work the
  // same way — the snapshot describes whatever the original was.
  let replySnapshot: ReplySnapshot | null = null
  if (input.replyToId) {
    replySnapshot = await buildReplySnapshot(admin, input.replyToId, input.conversationId)
    if (!replySnapshot) return { ok: false, error: 'The message you are replying to is unavailable.' }
  }

  const voiceMeta: Record<string, unknown> = {
    durationMs: Math.round(input.durationMs), peaks, transcript: null, transcriptStatus: 'pending',
  }
  if (replySnapshot) voiceMeta.replyTo = replySnapshot

  const { data: msg, error: msgErr } = await admin
    .from('messages')
    .insert({
      conversation_id: input.conversationId,
      sender_id: me.employeeId,
      body: '',
      kind: 'voice',
      metadata: voiceMeta,
    })
    .select('id, conversation_id, sender_id, parent_id, body, kind, metadata, edited_at, deleted_at, created_at')
    .single()
  if (msgErr) return { ok: false, error: msgErr.message }

  const { error: attErr } = await admin.from('message_attachments').insert({
    message_id: msg.id,
    storage_path: input.storagePath,
    file_name: `voice-note-${new Date().toISOString().slice(0, 10)}.webm`,
    mime_type: input.mimeType || 'audio/webm',
    size_bytes: input.sizeBytes,
  })
  if (attErr) return { ok: false, error: attErr.message }

  void admin.from('conversation_members')
    .update({ last_read_at: msg.created_at })
    .eq('conversation_id', input.conversationId)
    .eq('employee_id', me.employeeId)
    .then(undefined, () => {})

  // Transcribe after the response is sent (Vercel keeps the lambda alive for after()).
  after(() => transcribeVoiceNote(msg.id, input.storagePath))

  if (replySnapshot) afterReplyHooks(me, replySnapshot, input.conversationId, msg.id)

  const [enriched] = await enrichMessages(admin, [mapMessage(msg)], me.employeeId)
  return { ok: true, data: { ...enriched, senderName: me.name, senderCqid: me.cqid } }
}

/** Internal: download the audio, run Whisper, store the transcript on the message. */
async function transcribeVoiceNote(messageId: string, storagePath: string): Promise<void> {
  const admin = createAdminClient()
  const fail = () => admin.from('messages')
    .update({ metadata: { transcriptStatus: 'failed' } }) // merged below — read first
  try {
    const { data: current } = await admin
      .from('messages').select('metadata').eq('id', messageId).maybeSingle()
    const meta = (current?.metadata ?? {}) as Record<string, unknown>

    const { data: blob, error } = await admin.storage
      .from('chat-attachments').download(storagePath)
    if (error || !blob) {
      await admin.from('messages')
        .update({ metadata: { ...meta, transcriptStatus: 'failed' } }).eq('id', messageId)
      return
    }
    const text = await transcribeAudio(blob)
    await admin.from('messages')
      .update({
        metadata: {
          ...meta,
          transcript: text,
          transcriptStatus: text ? 'done' : 'failed',
        },
      })
      .eq('id', messageId)
  } catch (err) {
    console.warn('[voice] transcription failed:', err)
    try { await fail().eq('id', messageId) } catch { /* best-effort */ }
  }
}

/** Fetch ONE enriched message — used by clients to hydrate realtime-received
 *  voice/file messages with signed attachment URLs. */
export async function getMessage(messageId: string): Promise<Result<ChatMessage>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const { data: row } = await admin
    .from('messages')
    .select('id, conversation_id, sender_id, parent_id, body, kind, metadata, edited_at, deleted_at, created_at, sender:sender_id(name, cqid)')
    .eq('id', messageId).maybeSingle()
  if (!row) return { ok: false, error: 'Message not found.' }
  const membership = await requireMembership(row.conversation_id, auth.me.employeeId)
  if (!membership.ok) return membership
  const [enriched] = await enrichMessages(admin, [mapMessage(row)], auth.me.employeeId)
  return { ok: true, data: enriched }
}

// ── Client list + entity discussions (F5/F6) ──────────────────────────────────

/** Active clients for the "client channel" dropdown. */
export async function listClientsForChat(): Promise<Result<{ id: string; name: string }[]>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('clients')
    .select('id, name, is_active')
    .eq('is_active', true)
    .order('name')
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: (data ?? []).map(c => ({ id: c.id, name: c.name ?? '' })) }
}

export type DiscussEntityType = 'task' | 'project' | 'request' | 'client'

const ENTITY_TABLE: Record<DiscussEntityType, { table: string; labelCol: string; convCol: string }> = {
  task:    { table: 'tasks',         labelCol: 'title',         convCol: 'task_id' },
  project: { table: 'ad_projects',   labelCol: 'campaign_name', convCol: 'project_id' },
  request: { table: 'task_requests', labelCol: 'title',         convCol: 'request_id' },
  client:  { table: 'clients',       labelCol: 'name',          convCol: 'client_id' },
}

/**
 * Find (or create) the discussion room for a CRM entity, join the caller,
 * and return the conversation id. Powers the "Discuss" buttons on requests,
 * tasks, advertising projects and clients — one room per entity (unique
 * indexes in migration 019).
 */
export async function getOrCreateEntityConversation(
  entityType: DiscussEntityType,
  entityId: string,
): Promise<Result<{ id: string }>> {
  const auth = await requireChatUser()
  if (!auth.ok) return auth
  const me = auth.me
  const admin = createAdminClient()
  const cfg = ENTITY_TABLE[entityType]
  if (!cfg) return { ok: false, error: 'Unsupported entity type.' }

  // Entity must exist (also yields the room name). Dynamic column → cast.
  const { data: entityRaw } = await admin
    .from(cfg.table).select(`id, ${cfg.labelCol}`).eq('id', entityId).maybeSingle()
  const entity = entityRaw as unknown as Record<string, unknown> | null
  if (!entity) return { ok: false, error: 'Record not found.' }
  const label = String(entity[cfg.labelCol] ?? entityType)

  // Existing room?
  const { data: existing } = await admin
    .from('conversations')
    .select('id')
    .eq('type', entityType)
    .eq(cfg.convCol, entityId)
    .is('archived_at', null)
    .maybeSingle()

  let convId = existing?.id as string | undefined
  if (!convId) {
    const { data: conv, error } = await admin
      .from('conversations')
      .insert({
        type: entityType,
        name: label.slice(0, 80),
        is_private: false,
        [cfg.convCol]: entityId,
        created_by: me.employeeId,
      })
      .select('id').single()
    if (error) {
      // Unique-index race: someone created it concurrently — fetch theirs.
      const { data: retry } = await admin
        .from('conversations').select('id')
        .eq('type', entityType).eq(cfg.convCol, entityId).maybeSingle()
      if (!retry) return { ok: false, error: error.message }
      convId = retry.id
    } else {
      convId = conv.id
      void logActivity({
        actorId: me.employeeId, entityType: 'message', entityId: convId,
        action: 'created', category: 'chat', conversationId: convId,
        detail: { label: `Discussion: ${label.slice(0, 50)}` },
      })
    }
  }

  // Auto-join the caller (idempotent) — Discuss = open + become a member.
  await admin.from('conversation_members').upsert(
    { conversation_id: convId, employee_id: me.employeeId, role: 'member' },
    { onConflict: 'conversation_id,employee_id', ignoreDuplicates: true },
  )

  return { ok: true, data: { id: convId! } }
}
