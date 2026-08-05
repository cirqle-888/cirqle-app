'use client'

/**
 * ChatClient — team chat (Cirqle Connect, Phase 1 + 2).
 *
 * Panes: conversation list ⇄ thread ⇄ (optional) reply-thread panel.
 * Live: ONE Supabase Realtime subscription on `messages` for the open
 * conversation (RLS-authorized, migration 015); list polls every 30s.
 *
 * Phase 2: @mention autocomplete + bell notifications, reply threads,
 * emoji reactions, file attachments (signed-URL upload), message search,
 * ?c=<id> deep links (used by mention notifications).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Hash, Lock, MessageSquare, Plus, Send, ArrowLeft, Users2,
  Trash2, RefreshCw, X, Paperclip, Search, SmilePlus, Reply, Download, FileText, ClipboardCheck,
  CornerUpLeft, Mic, Check, CheckCheck, Pencil, Pin, CheckSquare, Megaphone, CalendarDays, Inbox
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import { ApprovalCard } from '@/components/approvals/approval-card'
import { VoiceRecorderButton, VoiceBubble, type VoiceRecording } from '@/components/chat/voice'
import { RequestApprovalDialog } from '@/components/approvals/request-approval-dialog'
import {
  listConversations, createChannel, getOrCreateDm, joinChannel,
  listChatEmployees, getMessages, getThread, sendMessage, deleteMessage, editMessage, markRead,
  toggleReaction, createAttachmentUploadUrl, sendFileMessage, searchMessages,
  sendVoiceMessage, getMessage, getReadReceipts, markVoicePlayed, listClientsForChat,
  archiveConversation, addMembersToConversation, removeMemberFromConversation,
  type ChatConversation, type ChatMessage, type ChatSearchHit, type ReplySnapshot, type ReadReceiptDetail,
} from './actions'

const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '✅', '👀']

/** What kind of record a discussion room hangs off — shown as a row badge so
 *  a task thread is never mistaken for a plan or a campaign. */
const ENTITY_BADGE: Record<string, { label: string; cls: string; Icon: React.ElementType }> = {
  task:    { label: 'Task',     cls: 'bg-blue-500/15 text-blue-600 dark:text-blue-300', Icon: CheckSquare },
  request: { label: 'Request',  cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-300', Icon: Inbox },
  plan:    { label: 'Plan',     cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-300', Icon: CalendarDays },
  project: { label: 'Campaign', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300', Icon: Megaphone },
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const that = new Date(d);  that.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - that.getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}
function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'
}
function typingLabel(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return `${names[0]} and ${names.length - 1} others are typing…`
}
function formatBytes(n: number | null): string {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

type Me = { employeeId: string; name: string; cqid: string }

// ── Component ─────────────────────────────────────────────────────────────────

export function ChatClient(props: { me: Me; canCreateChannels: boolean }) {
  return (
    <Suspense>
      <ChatInner {...props} />
    </Suspense>
  )
}

function ChatInner({ me, canCreateChannels }: { me: Me; canCreateChannels: boolean }) {
  const searchParams = useSearchParams()
  const deepLinkId = searchParams.get('c')

  // ── Privacy: CQID-first everywhere; names only for admin + reveal toggle ──
  const { revealNames } = usePermissions()
  const showName = useCallback(
    (name?: string | null, cqid?: string | null) =>
      displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true }),
    [revealNames],
  )
  /** DM conversation names arrive as "CQID||Name" — resolve per privacy. */
  const convDisplayName = useCallback((conv: ChatConversation): string => {
    if (conv.type === 'dm' && conv.name?.includes('||')) {
      const [cqid, name] = conv.name.split('||')
      return showName(name, cqid)
    }
    return conv.name ?? ''
  }, [showName])

  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [threadRootId, setThreadRootId] = useState<string | null>(null)
  const [showNewMenu, setShowNewMenu] = useState<null | 'channel' | 'dm'>(null)
  const [showApprovalDialog, setShowApprovalDialog] = useState(false)
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)

  const [workNavFilter, setWorkNavFilter] = useState('All')
  const [workNavSearch, setWorkNavSearch] = useState('')
  const [showWorkNavMobile, setShowWorkNavMobile] = useState(false)
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      try { return JSON.parse(localStorage.getItem('chat_pinned_ids') || '[]') } catch { return [] }
    }
    return []
  })

  const togglePin = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setPinnedIds(prev => {
      const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      localStorage.setItem('chat_pinned_ids', JSON.stringify(next))
      return next
    })
  }, [])
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<ChatSearchHit[] | null>(null)
  const [pending, startTransition] = useTransition()
  const bottomRef = useRef<HTMLDivElement>(null)
  const deepLinked = useRef(false)

  const active = useMemo(
    () => conversations.find(c => c.id === activeId) ?? null,
    [conversations, activeId],
  )

  // ── Conversation list: deferred initial load + 30s poll ────────────────────
  const refreshList = useCallback(async () => {
    const res = await listConversations()
    if (res.ok) { setConversations(res.data); setListError(null) }
    else setListError(res.error)
  }, [])

  useEffect(() => {
    const t0 = setTimeout(refreshList, 0)
    const t = setInterval(refreshList, 30_000)
    return () => { clearTimeout(t0); clearInterval(t) }
  }, [refreshList])

  // ── Open a conversation ────────────────────────────────────────────────────
  const openConversation = useCallback((id: string) => {
    setActiveId(id)
    setMessages([])
    setOlderCursor(null)
    setThreadRootId(null)
    setReplyTo(null)
    startTransition(async () => {
      const res = await getMessages(id)
      if (res.ok) {
        setMessages(res.data.messages)
        setOlderCursor(res.data.nextCursor)
        void markRead(id)
        setConversations(prev => prev.map(c => (c.id === id ? { ...c, unread: 0 } : c)))
      }
    })
  }, [])

  // Deep link (?c=) — open once after the first list load
  useEffect(() => {
    if (deepLinked.current || !deepLinkId || conversations.length === 0) return
    if (conversations.some(c => c.id === deepLinkId)) {
      deepLinked.current = true
      const t = setTimeout(() => openConversation(deepLinkId), 0)
      return () => clearTimeout(t)
    }
  }, [deepLinkId, conversations, openConversation])

  // ── Realtime: ONE workspace-wide subscription (RLS scopes events to my
  //    conversations). Open conversation renders instantly; other rooms get
  //    live unread bumps + alerts — no more waiting on the 30s poll.
  const activeIdRef = useRef<string | null>(null)
  const conversationsRef = useRef<ChatConversation[]>([])
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  // Publish the active conversation globally so the app-wide DesktopNotifier
  // can suppress a native notification for the conversation I'm reading.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__cirqleActiveConv = activeId
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return () => { (window as any).__cirqleActiveConv = null }
  }, [activeId])
  useEffect(() => { conversationsRef.current = conversations }, [conversations])

  // Typing indicators — ephemeral realtime broadcast (no DB). Keyed by
  // employeeId with a timestamp; entries auto-expire ~4s after the last keypress.
  const chatChannelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const lastTypingSentRef = useRef(0)
  const [typingBy, setTypingBy] = useState<Record<string, { name: string; cqid: string; at: number }>>({})
  const broadcastTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingSentRef.current < 2000) return // throttle to once / 2s
    lastTypingSentRef.current = now
    chatChannelRef.current?.send({
      type: 'broadcast', event: 'typing',
      payload: { conversationId: activeIdRef.current, employeeId: me.employeeId, name: me.name, cqid: me.cqid },
    })
  }, [me.employeeId, me.name, me.cqid])
  // Expire stale typing entries so the indicator disappears when people stop.
  useEffect(() => {
    const t = setInterval(() => {
      setTypingBy(prev => {
        const now = Date.now()
        const next = Object.fromEntries(Object.entries(prev).filter(([, v]) => now - v.at < 4000))
        return Object.keys(next).length === Object.keys(prev).length ? prev : next
      })
    }, 1500)
    return () => clearInterval(t)
  }, [])
  // Clear the indicator when switching conversations (deferred — no sync
  // setState in an effect body, per the react-compiler lint rule).
  useEffect(() => { const t = setTimeout(() => setTypingBy({}), 0); return () => clearTimeout(t) }, [activeId])

  const [alerts, setAlerts] = useState<{ id: string; title: string; body: string; convId: string }[]>([])
  const [showMembers, setShowMembers] = useState(false)

  const notifyIncoming = useCallback((convId: string, senderId: string | null, kind: string, body: string) => {
    const conv = conversationsRef.current.find(c => c.id === convId)
    const member = conv?.members.find(mm => mm.employeeId === senderId)
    const sender = member ? showName(member.name, member.cqid) : 'New message'
    const where = conv ? (conv.type === 'dm' ? '' : ` in #${convDisplayName(conv)}`) : ''
    const preview = kind === 'voice' ? '🎤 Voice message' : kind === 'file' ? '📎 File' : kind === 'approval' ? '🟡 Approval request' : body.slice(0, 80)
    // 1. soft beep
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator(); const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.frequency.value = 880; gain.gain.setValueAtTime(0.08, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
      osc.start(); osc.stop(ctx.currentTime + 0.25)
      setTimeout(() => void ctx.close().catch(() => {}), 400)
    } catch { /* audio blocked until first interaction — fine */ }
    // 2. system notification when the window is hidden/unfocused.
    //    In the desktop app the app-wide DesktopNotifier owns native
    //    notifications (fires regardless of focus, with tone + dock bounce),
    //    so skip the web Notification here to avoid a double alert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inDesktop = typeof window !== 'undefined' && !!(window as any).__CIRQLE_DESKTOP__?.notify
    if (!inDesktop && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      try {
        const n = new Notification(`${sender}${where}`, { body: preview, tag: convId })
        n.onclick = () => { window.focus(); openConversation(convId); n.close() }
      } catch { /* unsupported */ }
    }
    // 3. in-app toast
    const alertId = crypto.randomUUID()
    setAlerts(prev => [...prev.slice(-2), { id: alertId, title: `${sender}${where}`, body: preview, convId }])
    setTimeout(() => setAlerts(prev => prev.filter(a => a.id !== alertId)), 6000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showName, convDisplayName])

  useEffect(() => {
    // Ask once for system-notification permission (no-op if decided already)
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const t = setTimeout(() => { void Notification.requestPermission().catch(() => {}) }, 2000)
      return () => clearTimeout(t)
    }
  }, [])

  useEffect(() => {
    const supabase = createClient()
    // Unique per mount — a static topic name gets reused (returns the same,
    // already-subscribed channel) if the previous mount's async removeChannel
    // hasn't finished yet, which throws under React Strict Mode's dev
    // double-effect remount.
    const channel = supabase
      .channel(`workspace-chat-${crypto.randomUUID()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          const convId = String(row.conversation_id)
          const mine = row.sender_id === me.employeeId

          if (convId === activeIdRef.current) {
            if (row.parent_id) return // thread replies render in the thread panel
            setMessages(prev => {
              if (prev.some(m => m.id === row.id)) return prev
              return [...prev, {
                id: String(row.id),
                conversationId: convId,
                senderId: (row.sender_id as string | null) ?? null,
                senderName: mine ? me.name : null,
                senderCqid: mine ? me.cqid : null,
                body: String(row.body ?? ''),
                kind: String(row.kind ?? 'text'),
                createdAt: String(row.created_at),
                editedAt: null,
                deletedAt: (row.deleted_at as string | null) ?? null,
                parentId: null,
                metadata: (row.metadata as Record<string, unknown>) ?? {},
                replyCount: 0,
                reactions: {},
                attachments: [],
                readerIds: [],
                playedByIds: [],
              }]
            })
            if (!mine) {
              void markRead(convId)
              if (row.kind !== 'text') {
                void getMessage(String(row.id)).then(res => {
                  if (res.ok) setMessages(prev => prev.map(m => (m.id === res.data.id ? res.data : m)))
                })
              }
            }
            return
          }

          // Message in ANOTHER conversation: live unread bump + alert.
          if (mine) return
          setConversations(prev => prev.map(c => c.id === convId
            ? {
                ...c,
                unread: c.unread + 1,
                lastMessage: {
                  body: String(row.kind ?? 'text') === 'text' ? String(row.body ?? '') : `[${row.kind}]`,
                  senderName: null, senderCqid: null,
                  createdAt: String(row.created_at),
                },
              }
            : c))
          notifyIncoming(convId, (row.sender_id as string | null) ?? null, String(row.kind ?? 'text'), String(row.body ?? ''))
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_reads' },
        (payload) => {
          const row = payload.new as { message_id?: string; employee_id?: string; conversation_id?: string }
          if (!row.message_id || !row.employee_id) return
          if (row.conversation_id !== activeIdRef.current) return
          setMessages(prev => prev.map(m =>
            m.id === row.message_id && m.senderId === me.employeeId && !m.readerIds.includes(row.employee_id!)
              ? { ...m, readerIds: [...m.readerIds, row.employee_id!] }
              : m))
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          if (row.conversation_id !== activeIdRef.current) return
          setMessages(prev => prev.map(m => m.id === row.id
            ? {
                ...m,
                body: String(row.body ?? ''),
                deletedAt: (row.deleted_at as string | null) ?? null,
                editedAt: (row.edited_at as string | null) ?? null,
                metadata: (row.metadata as Record<string, unknown>) ?? m.metadata,
              }
            : m))
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_plays' },
        (payload) => {
          const row = payload.new as { message_id?: string; employee_id?: string; conversation_id?: string }
          if (!row.message_id || !row.employee_id) return
          if (row.conversation_id !== activeIdRef.current) return
          setMessages(prev => prev.map(m =>
            m.id === row.message_id && m.senderId === me.employeeId && !m.playedByIds.includes(row.employee_id!)
              ? { ...m, playedByIds: [...m.playedByIds, row.employee_id!] }
              : m))
        })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const p = payload as { conversationId?: string; employeeId?: string; name?: string; cqid?: string }
        if (!p.employeeId || p.employeeId === me.employeeId) return
        if (p.conversationId !== activeIdRef.current) return
        setTypingBy(prev => ({ ...prev, [p.employeeId!]: { name: p.name ?? '', cqid: p.cqid ?? '', at: Date.now() } }))
      })
      .subscribe()
    chatChannelRef.current = channel
    return () => { chatChannelRef.current = null; void supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.employeeId, me.name, me.cqid])

  const memberNames = useMemo(() => {
    const map = new Map<string, string>()
    active?.members.forEach(m => map.set(m.employeeId, showName(m.name, m.cqid)))
    return map
  }, [active, showName])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleSendRoot = useCallback((text: string) => {
    if (!activeId) return
    const replyToId = replyTo?.id ?? null
    const replySnap = replyTo
    setReplyTo(null)
    // Optimistic: render instantly, reconcile with the server row on ack.
    const tempId = `tmp-${crypto.randomUUID()}`
    const optimistic: ChatMessage = {
      id: tempId, conversationId: activeId, senderId: me.employeeId,
      senderName: me.name, senderCqid: me.cqid, body: text, kind: 'text',
      createdAt: new Date().toISOString(), editedAt: null, deletedAt: null,
      parentId: null,
      metadata: replySnap ? { replyTo: {
        messageId: replySnap.id, senderId: replySnap.senderId,
        senderName: replySnap.senderName ?? '', senderCqid: replySnap.senderCqid ?? '',
        kind: replySnap.kind, preview: replySnap.kind === 'text' ? replySnap.body.slice(0, 90) : replySnap.kind,
      } } : {},
      replyCount: 0, reactions: {}, attachments: [], readerIds: [], playedByIds: [],
    }
    setMessages(prev => [...prev, optimistic])
    startTransition(async () => {
      const res = await sendMessage(activeId, text, { replyToId })
      if (res.ok) {
        setMessages(prev => prev.map(m => (m.id === tempId ? res.data : m))
          .filter((m, i, arr) => arr.findIndex(x => x.id === m.id) === i)) // dedupe vs realtime echo
      } else {
        setMessages(prev => prev.filter(m => m.id !== tempId))
        alert(res.error)
      }
    })
  }, [activeId, replyTo, me])

  const handleUpload = useCallback((file: File) => {
    if (!activeId) return
    startTransition(async () => {
      const prep = await createAttachmentUploadUrl({
        conversationId: activeId, fileName: file.name, sizeBytes: file.size,
      })
      if (!prep.ok) { alert(prep.error); return }
      const supabase = createClient()
      const { error: upErr } = await supabase.storage
        .from('chat-attachments')
        .uploadToSignedUrl(prep.data.storagePath, prep.data.token, file)
      if (upErr) { alert(`Upload failed: ${upErr.message}`); return }
      const res = await sendFileMessage({
        conversationId: activeId,
        storagePath: prep.data.storagePath,
        fileName: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
      })
      if (res.ok) setMessages(prev => (prev.some(m => m.id === res.data.id) ? prev : [...prev, res.data]))
      else alert(res.error)
    })
  }, [activeId])

  const handleVoice = useCallback((rec: VoiceRecording) => {
    if (!activeId) return
    const replyToId = replyTo?.id ?? null
    setReplyTo(null)
    startTransition(async () => {
      const prep = await createAttachmentUploadUrl({
        conversationId: activeId, fileName: 'voice-note.webm', sizeBytes: rec.blob.size,
      })
      if (!prep.ok) { alert(prep.error); return }
      const supabase = createClient()
      const { error: upErr } = await supabase.storage
        .from('chat-attachments')
        .uploadToSignedUrl(prep.data.storagePath, prep.data.token, rec.blob)
      if (upErr) { alert(`Upload failed: ${upErr.message}`); return }
      const res = await sendVoiceMessage({
        conversationId: activeId,
        storagePath: prep.data.storagePath,
        durationMs: rec.durationMs,
        peaks: rec.peaks,
        mimeType: rec.mimeType,
        sizeBytes: rec.blob.size,
        replyToId,
      })
      if (res.ok) setMessages(prev => (prev.some(m => m.id === res.data.id) ? prev : [...prev, res.data]))
      else alert(res.error)
    })
  }, [activeId, replyTo])

  const handleReact = useCallback((messageId: string, emoji: string) => {
    // Optimistic toggle
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId) return m
      const mine = (m.reactions[emoji] ?? []).includes(me.employeeId)
      const next = { ...m.reactions }
      next[emoji] = mine
        ? (next[emoji] ?? []).filter(id => id !== me.employeeId)
        : [...(next[emoji] ?? []), me.employeeId]
      if (next[emoji].length === 0) delete next[emoji]
      return { ...m, reactions: next }
    }))
    startTransition(async () => { await toggleReaction(messageId, emoji) })
  }, [me.employeeId])

  const jumpToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`)
    if (!el) return // original not in the loaded page — could load older; keep simple
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightId(messageId)
    setTimeout(() => setHighlightId(h => (h === messageId ? null : h)), 1600)
  }, [])

  const handleJoin = useCallback((id: string) => {
    startTransition(async () => {
      const res = await joinChannel(id)
      if (res.ok) { await refreshList(); openConversation(id) }
      else alert(res.error)
    })
  }, [refreshList, openConversation])

  // Delete a conversation. DMs hide for this member only; shared rooms archive
  // globally — the server enforces both rules, this just asks first.
  const [deleteTarget, setDeleteTarget] = useState<{ conv: ChatConversation; label: string } | null>(null)
  const askDeleteConv = useCallback((conv: ChatConversation, label: string) => {
    setDeleteTarget({ conv, label })
  }, [])
  const confirmDeleteConv = useCallback(() => {
    const target = deleteTarget
    if (!target) return
    setDeleteTarget(null)
    startTransition(async () => {
      const res = await archiveConversation(target.conv.id)
      if (!res.ok) { alert(res.error); return }
      setConversations(prev => prev.filter(c => c.id !== target.conv.id))
      setActiveId(prev => (prev === target.conv.id ? null : prev))
    })
  }, [deleteTarget])

  const handleLoadOlder = useCallback(() => {
    if (!activeId || !olderCursor) return
    startTransition(async () => {
      const res = await getMessages(activeId, olderCursor)
      if (res.ok) {
        setMessages(prev => [...res.data.messages, ...prev])
        setOlderCursor(res.data.nextCursor)
      }
    })
  }, [activeId, olderCursor])

  // Search (debounced; state updates always deferred past the effect body)
  useEffect(() => {
    const short = searchQ.trim().length < 2
    const t = setTimeout(async () => {
      if (short) { setSearchHits(null); return }
      const res = await searchMessages(searchQ)
      if (res.ok) setSearchHits(res.data)
    }, short ? 0 : 250)
    return () => clearTimeout(t)
  }, [searchQ])

  const grouped = useMemo(() => {
    const out: { label: string; rows: ChatMessage[] }[] = []
    for (const m of messages) {
      const label = dayLabel(m.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.rows.push(m)
      else out.push({ label, rows: [m] })
    }
    return out
  }, [messages])

  const isChannelish = (c: ChatConversation) => c.type === 'channel' || c.type === 'group'
  const clientChannels = conversations.filter(c => isChannelish(c) && c.category === 'client')
  const allDiscussions = conversations.filter(c => c.category === 'discussion' && c.isMember)

  // Every task / request / plan / campaign discussion is filed under its
  // client — one consolidated place per client instead of a flat pile that
  // grows without bound. A client group appears whenever the client has a
  // channel OR any discussion, so a client with no channel still collects its
  // threads instead of scattering them. Discussions with no client at all fall
  // back to a standalone "Other discussions" section — never unreachable.
  type ClientGroup = { clientId: string; name: string; channel: ChatConversation | null; threads: ChatConversation[]; unreadTotal: number }
  const clientGroups = new Map<string, ClientGroup>()
  const groupFor = (clientId: string, name: string): ClientGroup => {
    let g = clientGroups.get(clientId)
    if (!g) { g = { clientId, name, channel: null, threads: [], unreadTotal: 0 }; clientGroups.set(clientId, g) }
    if (name && g.name === 'Client') g.name = name
    return g
  }
  for (const ch of clientChannels) {
    if (!ch.clientId) continue
    const g = groupFor(ch.clientId, ch.clientName ?? convDisplayName(ch))
    g.channel = ch
    g.unreadTotal += ch.unread
  }
  for (const d of allDiscussions) {
    if (d.type === 'client') {
      if (d.clientId) {
        const g = groupFor(d.clientId, d.clientName ?? convDisplayName(d))
        g.channel ??= d
        g.unreadTotal += d.unread
      }
      continue
    }
    if (!d.clientId) continue
    const g = groupFor(d.clientId, d.clientName ?? 'Client')
    g.threads.push(d)
    g.unreadTotal += d.unread
  }
  // Client channels that never got a clientId can't be grouped — keep them
  // visible as their own standalone entries rather than dropping them.
  const ungroupedClientChannels = clientChannels.filter(c => !c.clientId)
  const groupedIds = new Set(
    [...clientGroups.values()].flatMap(g => [g.channel?.id, ...g.threads.map(t => t.id)]).filter(Boolean) as string[],
  )
  const sortedClientGroups = [...clientGroups.values()].sort((a, b) => a.name.localeCompare(b.name))

  const groups = {
    general:     conversations.filter(c => isChannelish(c) && (c.category ?? 'general') === 'general'),
    department:  conversations.filter(c => isChannelish(c) && c.category === 'department'),
    discussion:  allDiscussions.filter(c => !groupedIds.has(c.id)),
    dms:         conversations.filter(c => c.type === 'dm'),
  }

  const activeClientGroup = useMemo(() => {
    if (activeId?.startsWith('client:')) return clientGroups.get(activeId.replace('client:', ''))
    if (active?.clientId) return clientGroups.get(active.clientId)
    return null
  }, [activeId, active, clientGroups])

  return (
    <div className="flex h-full">
      {/* ── Delete confirmation ── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          onMouseDown={e => { if (e.target === e.currentTarget) setDeleteTarget(null) }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-2xl">
            <h3 className="mb-2 text-sm font-semibold">Delete “{deleteTarget.label}”?</h3>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
              {deleteTarget.conv.type === 'dm'
                ? 'This removes the conversation from your list only. The other person keeps it, and it comes back here if they message you again.'
                : deleteTarget.conv.category === 'discussion'
                  ? 'This removes the discussion from everyone’s list. Messages are kept, and the Discuss button on the record reopens it.'
                  : 'This removes the conversation from everyone’s list. Messages are kept.'}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteTarget(null)}
                className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground">
                Cancel
              </button>
              <button onClick={confirmDeleteConv}
                className="flex-1 rounded-xl bg-red-600 py-2.5 text-sm font-semibold text-white hover:bg-red-500">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Pane 1: list + search ── */}
      <aside className={`${activeId ? 'hidden md:flex' : 'flex'} w-full md:w-72 shrink-0 flex-col border-r border-border bg-background`}>
        {/* pl-14 on mobile clears the fixed global sidebar hamburger (see the
            thread header below); md:px-4 restores normal desktop padding. */}
        <div className="flex items-center justify-between pl-14 pr-4 md:px-4 py-3 border-b border-border">
          <h1 className="text-base font-semibold">Chat</h1>
          <div className="flex items-center gap-1">
            <button onClick={() => refreshList()} className="rounded p-1.5 text-muted-foreground hover:text-foreground" aria-label="Refresh">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button onClick={() => setShowNewMenu('dm')} className="rounded p-1.5 text-muted-foreground hover:text-foreground" aria-label="New message">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search messages…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {searchQ && (
              <button onClick={() => setSearchQ('')} aria-label="Clear search">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {listError && <p className="px-4 py-2 text-xs text-destructive">{listError}</p>}

          {searchHits !== null ? (
            <>
              <SectionLabel>Results</SectionLabel>
              {searchHits.length === 0 && <p className="px-4 py-2 text-xs text-muted-foreground">No messages found.</p>}
              {searchHits.map(hit => (
                <button key={hit.messageId}
                  onClick={() => { setSearchQ(''); openConversation(hit.conversationId) }}
                  className="w-full px-4 py-2 text-left hover:bg-muted/50">
                  <span className="block text-xs font-medium">
                    {hit.conversationName ?? 'Direct message'}
                    <span className="ml-2 font-normal text-muted-foreground">{dayLabel(hit.createdAt)}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {hit.senderCqid || hit.senderName ? `${showName(hit.senderName, hit.senderCqid)}: ` : ''}{hit.snippet}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <>
              {([
                ['Channels', groups.general, true],
                ['Departments', groups.department, false],
              ] as [string, ChatConversation[], boolean][]).map(([label, list, always]) => (
                (always || list.length > 0) && (
                  <div key={label}>
                    <SectionLabel>{label}</SectionLabel>
                    {list.map(c => (
                      <ConversationRow key={c.id} conv={c} active={c.id === activeId}
                        displayName={convDisplayName(c)} showName={showName}
                        onDelete={c.canDelete ? askDeleteConv : undefined}
                        onClick={() => (c.isMember ? openConversation(c.id) : handleJoin(c.id))} />
                    ))}
                    {label === 'Channels' && canCreateChannels && (
                      <button onClick={() => setShowNewMenu('channel')}
                        className="flex w-full items-center gap-2 px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                        <Plus className="h-3.5 w-3.5" /> New channel
                      </button>
                    )}
                  </div>
                )
              ))}

              {/* ── Clients: channel + that client's threads underneath ── */}
              {(sortedClientGroups.length > 0 || ungroupedClientChannels.length > 0) && (
                <div>
                  <SectionLabel>Clients</SectionLabel>
                  {sortedClientGroups.map(g => {
                    const rowActive = g.channel?.id === activeId || g.threads.some(t => t.id === activeId) || activeId === `client:${g.clientId}`
                    return (
                    <div key={g.clientId}>
                      {g.channel ? (
                        <ConversationRow conv={{ ...g.channel, unread: g.unreadTotal }} active={rowActive}
                          displayName={convDisplayName(g.channel)} showName={showName}
                          onDelete={g.channel.canDelete ? askDeleteConv : undefined}
                          onClick={() => (g.channel!.isMember ? openConversation(g.channel!.id) : handleJoin(g.channel!.id))} />
                      ) : (
                        <div className={`group/row flex w-full items-center transition-colors ${rowActive ? 'bg-muted' : 'hover:bg-muted/50'}`}>
                          <button onClick={() => setActiveId(`client:${g.clientId}`)}
                            className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-4 pr-1 text-left">
                            <Hash className="h-4 w-4 shrink-0 text-muted-foreground opacity-50" />
                            <span className="min-w-0 flex-1">
                              <span className={`flex items-center gap-1.5 text-sm`}>
                                <span className={`truncate ${g.unreadTotal > 0 ? 'font-semibold text-foreground' : ''}`}>{g.name}</span>
                              </span>
                            </span>
                            {g.unreadTotal > 0 && (
                              <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[10px] font-semibold text-background">
                                {g.unreadTotal > 99 ? '99+' : g.unreadTotal}
                              </span>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  )})}
                  {ungroupedClientChannels.map(c => (
                    <ConversationRow key={c.id} conv={c} active={c.id === activeId}
                      displayName={convDisplayName(c)} showName={showName}
                      onDelete={c.canDelete ? askDeleteConv : undefined}
                      onClick={() => (c.isMember ? openConversation(c.id) : handleJoin(c.id))} />
                  ))}
                </div>
              )}

              {groups.discussion.length > 0 && (
                <div>
                  <SectionLabel>Other discussions</SectionLabel>
                  {groups.discussion.map(c => (
                    <ConversationRow key={c.id} conv={c} active={c.id === activeId}
                      displayName={convDisplayName(c)} showName={showName}
                      onDelete={c.canDelete ? askDeleteConv : undefined}
                      onClick={() => openConversation(c.id)} />
                  ))}
                </div>
              )}

              <SectionLabel>Direct messages</SectionLabel>
              {groups.dms.map(c => (
                <ConversationRow key={c.id} conv={c} active={c.id === activeId}
                  displayName={convDisplayName(c)} showName={showName}
                  onDelete={c.canDelete ? askDeleteConv : undefined}
                  onClick={() => openConversation(c.id)} />
              ))}
              {groups.dms.length === 0 && (
                <p className="px-4 py-1 text-xs text-muted-foreground">No direct messages yet.</p>
              )}
            </>
          )}
        </div>
      </aside>

      {/* ── Pane 2: thread ── */}
      <section className={`${activeId && !threadRootId && !(activeId && showWorkNavMobile) ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-background`}>
        {!active ? (
          activeClientGroup ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center px-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Hash className="h-6 w-6 text-muted-foreground" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">General Discussion</h3>
                <p className="mt-1 text-sm text-muted-foreground">Discuss anything related to this client here.</p>
              </div>
              <button disabled={pending}
                onClick={() => startTransition(async () => {
                  const name = activeClientGroup.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
                  const res = await createChannel({ name, topic: '', isPrivate: false, category: 'client', clientId: activeClientGroup.clientId })
                  if (res.ok) { await refreshList(); openConversation(res.data.id) }
                  else alert(res.error)
                })}
                className="mt-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
                Start Discussion
              </button>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <MessageSquare className="h-8 w-8" />
              <p className="text-sm">Pick a conversation, or start a new one.</p>
            </div>
          )
        ) : (
          <>
            {/* pl-14 on mobile: the app's global sidebar hamburger is fixed at
                the top-left corner (16–52px), which sat directly on top of this
                Back button — a mobile user literally could not tap 'back' to
                return to the conversation list. Padding shifts the header
                content clear of it. md:px-4 restores normal padding on desktop
                where the hamburger is md:hidden. */}
            <div className="flex items-center gap-2 border-b border-border pl-14 pr-4 md:px-4 py-3">
              <button onClick={() => setActiveId(null)} className="md:hidden rounded p-1 text-muted-foreground" aria-label="Back">
                <ArrowLeft className="h-4 w-4" />
              </button>
              {active.type === 'dm'
                ? <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium">{initials(convDisplayName(active))}</span>
                : active.isPrivate ? <Lock className="h-4 w-4 text-muted-foreground" /> : <Hash className="h-4 w-4 text-muted-foreground" />}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{convDisplayName(active)}</p>
                {active.topic && <p className="truncate text-xs text-muted-foreground">{active.topic}</p>}
              </div>
              <span className="ml-auto inline-flex items-center gap-2">
                <button onClick={() => setShowApprovalDialog(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  title="Request approval in this conversation">
                  <ClipboardCheck className="h-3.5 w-3.5" /> Approval
                </button>
                <button onClick={() => setShowMembers(true)}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors">
                  <Users2 className="h-3.5 w-3.5" /> {active.members.length}
                </button>
                {activeClientGroup && !threadRootId && (
                  <button onClick={() => setShowWorkNavMobile(true)} className="md:hidden ml-1 inline-flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs font-medium hover:bg-muted/80">
                    Work {activeClientGroup.unreadTotal > 0 && <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-[9px] text-background">{activeClientGroup.unreadTotal > 99 ? '99+' : activeClientGroup.unreadTotal}</span>}
                  </button>
                )}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
              {olderCursor && (
                <button onClick={handleLoadOlder} disabled={pending}
                  className="mx-auto mb-3 block rounded-full border border-border px-3 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
                  Load earlier messages
                </button>
              )}
              {grouped.map(g => (
                <div key={g.label}>
                  <div className="my-3 flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">{g.label}</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  {g.rows.map(m => (
                    <MessageRow key={m.id} m={m} me={me}
                      senderName={m.senderId === me.employeeId
                        ? showName(me.name, me.cqid)
                        : (m.senderId ? memberNames.get(m.senderId) ?? showName(m.senderName, m.senderCqid) : 'System')}
                      isDm={active.type === 'dm'}
                      memberCount={active.members.length}
                      highlighted={highlightId === m.id}
                      onDelete={() => startTransition(async () => { await deleteMessage(m.id) })}
                      onEdit={async body => {
                        setMessages(prev => prev.map(x => x.id === m.id ? { ...x, body, editedAt: new Date().toISOString() } : x))
                        const res = await editMessage(m.id, body)
                        if (!res.ok) { const fresh = await getMessage(m.id); if (fresh.ok) setMessages(prev => prev.map(x => x.id === m.id ? fresh.data : x)) }
                      }}
                      onPlayVoice={() => { void markVoicePlayed(m.id) }}
                      onReact={emoji => handleReact(m.id, emoji)}
                      onReply={() => setThreadRootId(m.id)}
                      onQuote={() => setReplyTo(m)}
                      onJumpTo={jumpToMessage}
                      showName={showName}
                    />
                  ))}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {Object.keys(typingBy).length > 0 && (
              <div className="flex items-center gap-1.5 px-4 pb-0.5 text-xs text-muted-foreground">
                <span className="flex gap-0.5">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
                </span>
                {typingLabel(Object.values(typingBy).map(v => showName(v.name, v.cqid)))}
              </div>
            )}
            <Composer
              placeholder={`Message ${active.type === 'dm' ? convDisplayName(active) : `#${convDisplayName(active)}`}`}
              members={active.members.filter(m => m.employeeId !== me.employeeId)}
              disabled={pending}
              onSend={handleSendRoot}
              onTyping={broadcastTyping}
              onFile={handleUpload}
              onVoice={handleVoice}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              showName={showName}
            />
          </>
        )}
      </section>
      {/* ── Pane 3: Thread / Work Navigator ── */}
      {threadRootId && activeId ? (
        <ThreadPanel rootId={threadRootId} conversationId={activeId} me={me} members={active?.members ?? []}
          onClose={() => setThreadRootId(null)} onReplySent={() => {
            setMessages(prev => prev.map(m => m.id === threadRootId ? { ...m, replyCount: m.replyCount + 1 } : m))
          }} />
      ) : activeClientGroup ? (
        <div className={`${showWorkNavMobile ? 'flex' : 'hidden md:flex'} fixed inset-0 z-40 bg-background md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-border flex-col`}>
          <WorkNavigatorPanel
            clientGroup={activeClientGroup} activeId={activeId}
            filter={workNavFilter} search={workNavSearch} pinnedIds={pinnedIds}
            setFilter={setWorkNavFilter} setSearch={setWorkNavSearch}
            togglePin={togglePin} onSelect={(id) => { setActiveId(id); setShowWorkNavMobile(false) }}
            onClose={() => setShowWorkNavMobile(false)}
          />
        </div>
      ) : null}

      {/* Incoming-message toasts */}
      {alerts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2">
          {alerts.map(a => (
            <button key={a.id}
              onClick={() => { setAlerts(prev => prev.filter(x => x.id !== a.id)); openConversation(a.convId) }}
              className="rounded-xl border border-border bg-background p-3 text-left shadow-xl transition-transform hover:scale-[1.02]">
              <span className="block text-xs font-semibold">{a.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{a.body}</span>
            </button>
          ))}
        </div>
      )}

      {showApprovalDialog && activeId && (
        <RequestApprovalDialog
          conversationId={activeId}
          onClose={() => setShowApprovalDialog(false)}
          onCreated={() => {
            setShowApprovalDialog(false)
            // the kind='approval' message arrives via realtime; refresh as fallback
            openConversation(activeId)
          }}
        />
      )}

      {showNewMenu && (
        <NewConversationDialog
          mode={showNewMenu}
          canCreateChannels={canCreateChannels}
          onClose={() => setShowNewMenu(null)}
          onCreated={async (id) => { setShowNewMenu(null); await refreshList(); openConversation(id) }}
        />
      )}

      {showMembers && active && (
        <MembersDialog
          conversation={active}
          me={me}
          onClose={() => setShowMembers(false)}
        />
      )}
    </div>
  )
}

// ── Composer (shared by main thread + reply panel) ───────────────────────────

function Composer({ placeholder, members, disabled, onSend, onTyping, onFile, onVoice, replyTo, onCancelReply, showName }: {
  placeholder: string
  members: { employeeId: string; name: string; cqid: string }[]
  disabled: boolean
  onSend: (text: string) => void
  onTyping?: () => void
  onFile?: (file: File) => void
  onVoice?: (rec: VoiceRecording) => void
  replyTo?: ChatMessage | null
  onCancelReply?: () => void
  showName?: (name?: string | null, cqid?: string | null) => string
}) {
  const mask = showName ?? ((name?: string | null, cqid?: string | null) => cqid || name || '—')
  const [draft, setDraft] = useState('')
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return members
      .filter(m => !q || m.name.toLowerCase().includes(q) || m.cqid.toLowerCase().includes(q))
      .slice(0, 6)
  }, [mentionQuery, members])

  const updateDraft = (value: string) => {
    setDraft(value)
    if (value.trim()) onTyping?.()
    // Mention autocomplete: token after the last '@' before the caret
    const caret = taRef.current?.selectionStart ?? value.length
    const upToCaret = value.slice(0, caret)
    const at = upToCaret.lastIndexOf('@')
    if (at >= 0 && (at === 0 || /\s/.test(upToCaret[at - 1]))) {
      const token = upToCaret.slice(at + 1)
      if (!token.includes('\n') && token.length <= 24) { setMentionQuery(token); return }
    }
    setMentionQuery(null)
  }

  const insertMention = (m: { name: string; cqid: string }) => {
    const caret = taRef.current?.selectionStart ?? draft.length
    const upToCaret = draft.slice(0, caret)
    const at = upToCaret.lastIndexOf('@')
    // CQID-first: never leak names into message bodies via mentions.
    const next = `${draft.slice(0, at)}@${m.cqid || m.name} ${draft.slice(caret)}`
    setDraft(next)
    setMentionQuery(null)
    taRef.current?.focus()
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setMentionQuery(null)
    onSend(text)
  }

  return (
    <div className="relative border-t border-border p-3">
      {replyTo && onCancelReply && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-l-foreground/60 bg-muted/50 px-3 py-1.5">
          <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium">
              Replying to {mask(replyTo.senderName, replyTo.senderCqid)}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {replyTo.kind === 'voice'
                ? <><Mic className="mr-0.5 inline h-3 w-3" />Voice message</>
                : replyTo.kind === 'file' ? 'File' : replyTo.body}
            </span>
          </span>
          <button onClick={onCancelReply} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Cancel reply">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {mentionQuery !== null && mentionMatches.length > 0 && (
        <div className="absolute bottom-full left-3 z-20 mb-1 w-64 overflow-hidden rounded-xl border border-border bg-background shadow-lg">
          {mentionMatches.map(m => (
            <button key={m.employeeId} onClick={() => insertMention(m)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{initials(mask(m.name, m.cqid))}</span>
              <span className="text-sm">{mask(m.name, m.cqid)}</span>
              <span className="ml-auto text-xs text-muted-foreground">{m.cqid}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 focus-within:border-foreground/30">
        {onFile && (
          <>
            <input ref={fileRef} type="file" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = '' }} />
            <button onClick={() => fileRef.current?.click()} disabled={disabled}
              className="rounded p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40" aria-label="Attach file">
              <Paperclip className="h-4 w-4" />
            </button>
          </>
        )}
        <textarea
          ref={taRef}
          value={draft}
          onChange={e => updateDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && mentionQuery === null) { e.preventDefault(); send() }
            if (e.key === 'Escape') setMentionQuery(null)
          }}
          placeholder={placeholder}
          rows={Math.min(5, Math.max(1, draft.split('\n').length))}
          className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {onVoice && !draft.trim() ? (
          <VoiceRecorderButton disabled={disabled} onRecorded={onVoice} />
        ) : (
          <button onClick={send} disabled={!draft.trim() || disabled}
            className="rounded-lg bg-foreground p-2 text-background transition-opacity disabled:opacity-30" aria-label="Send">
            <Send className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Message row ───────────────────────────────────────────────────────────────

function MessageRow({ m, me, senderName, onDelete, onEdit, onPlayVoice, onReact, onReply, onQuote, onJumpTo, isDm = false, memberCount = 2, highlighted = false, inThread = false, showName }: {
  m: ChatMessage
  me: Me
  senderName: string
  onDelete: () => void
  onEdit?: (body: string) => Promise<void>
  onPlayVoice?: () => void
  onReact: (emoji: string) => void
  onReply?: () => void
  onQuote?: () => void
  onJumpTo?: (messageId: string) => void
  isDm?: boolean
  memberCount?: number
  highlighted?: boolean
  inThread?: boolean
  showName?: (name?: string | null, cqid?: string | null) => string
}) {
  const mask = showName ?? ((name?: string | null, cqid?: string | null) => cqid || name || '—')
  const [showEmoji, setShowEmoji] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const mine = m.senderId === me.employeeId
  const canEdit = mine && m.kind === 'text' && !!onEdit
  const beginEdit = () => { setDraft(m.body); setEditing(true) }
  const saveEdit = async () => {
    const next = draft.trim()
    if (!next || next === m.body) { setEditing(false); return }
    setSavingEdit(true)
    await onEdit?.(next)
    setSavingEdit(false)
    setEditing(false)
  }
  const replySnap = (m.metadata.replyTo ?? null) as ReplySnapshot | null
  const replyUnavailable = m.metadata.replyToUnavailable === true

  if (m.deletedAt) {
    return <p className="py-1 pl-10 text-xs italic text-muted-foreground">Message deleted</p>
  }

  if (m.kind === 'system') {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground font-medium text-center">
          {m.body}
        </span>
      </div>
    )
  }

  return (
    <div id={`msg-${m.id}`}
      className={`group relative flex items-start gap-2.5 rounded-lg py-1.5 transition-colors duration-500 ${highlighted ? 'bg-amber-500/15' : ''}`}>
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
        {initials(senderName)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-xs">
          <span className="font-semibold">{mine ? 'You' : senderName}</span>
          <span className="text-muted-foreground">{timeLabel(m.createdAt)}</span>
          {m.editedAt && <span className="text-muted-foreground">(edited)</span>}
          {mine && !inThread && (
            <ReadTicks m={m} isDm={isDm} memberCount={memberCount} mask={mask} />
          )}
        </p>
        {replySnap && (
          <button
            onClick={() => !replyUnavailable && onJumpTo?.(replySnap.messageId)}
            className={`mb-1 flex w-full max-w-sm items-center gap-2 rounded-lg border-l-2 border-l-foreground/50 bg-muted/50 px-2.5 py-1.5 text-left ${replyUnavailable ? 'cursor-default opacity-70' : 'hover:bg-muted'}`}>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-foreground/80">{mask(replySnap.senderName, replySnap.senderCqid)}</span>
              {replyUnavailable ? (
                <span className="block text-xs italic text-muted-foreground">
                  {replySnap.kind === 'voice' ? 'Original voice message unavailable' : 'Original message unavailable'}
                </span>
              ) : replySnap.kind === 'voice' ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Mic className="h-3 w-3 shrink-0" />
                  <span className="flex h-4 items-center gap-[1.5px]">
                    {(replySnap.peaks ?? Array.from({ length: 12 }, () => 0.5)).map((pk, i) => (
                      <span key={i} className="w-[2px] rounded-full bg-muted-foreground/60"
                        style={{ height: `${Math.max(20, pk * 100)}%` }} />
                    ))}
                  </span>
                  {typeof replySnap.durationMs === 'number' && (
                    <span className="tabular-nums">
                      {Math.floor(replySnap.durationMs / 60000)}:{String(Math.round(replySnap.durationMs / 1000) % 60).padStart(2, '0')}
                    </span>
                  )}
                </span>
              ) : (
                <span className="block truncate text-xs text-muted-foreground">
                  {replySnap.kind === 'file' && <FileText className="mr-0.5 inline h-3 w-3" />}
                  {replySnap.preview || (replySnap.kind === 'file' ? 'File' : '…')}
                </span>
              )}
            </span>
          </button>
        )}
        {m.kind === 'voice' ? (
          <VoiceBubble
            url={m.attachments[0]?.url ?? null}
            durationMs={typeof m.metadata.durationMs === 'number' ? m.metadata.durationMs : 0}
            peaks={Array.isArray(m.metadata.peaks) ? (m.metadata.peaks as number[]) : []}
            transcript={typeof m.metadata.transcript === 'string' ? m.metadata.transcript : null}
            transcriptStatus={typeof m.metadata.transcriptStatus === 'string' ? m.metadata.transcriptStatus : null}
            fileName={m.attachments[0]?.fileName}
            onFirstPlay={mine ? undefined : onPlayVoice}
            playedLabel={mine && m.playedByIds.length > 0
              ? (isDm ? 'Played' : `Played by ${m.playedByIds.length}`)
              : null}
          />
        ) : m.kind === 'approval' && typeof m.metadata.approvalId === 'string' ? (
          <ApprovalCard
            approvalId={m.metadata.approvalId}
            statusHint={typeof m.metadata.approvalStatus === 'string' ? m.metadata.approvalStatus : undefined}
            meId={me.employeeId}
          />
        ) : editing ? (
          <div className="mt-0.5">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit() }
                if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
              }}
              rows={Math.min(6, draft.split('\n').length)}
              autoFocus
              className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-1 flex items-center gap-2 text-xs">
              <button onClick={() => void saveEdit()} disabled={savingEdit}
                className="rounded bg-foreground px-2 py-0.5 font-medium text-background disabled:opacity-50">Save</button>
              <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground">Cancel</button>
              <span className="text-muted-foreground">Enter to save · Esc to cancel</span>
            </div>
          </div>
        ) : (
          m.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.body}</p>
        )}

        {/* Attachments */}
        {m.attachments.map(a => (
          a.mimeType?.startsWith('image/') && a.url ? (
            <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" className="mt-1 block max-w-xs">
              {/* Signed short-lived URL — next/image can't optimize these; plain img is intentional. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.url} alt={a.fileName} className="max-h-64 rounded-lg border border-border object-cover" />
            </a>
          ) : (
            <a key={a.id} href={a.url ?? '#'} target="_blank" rel="noopener noreferrer"
              className="mt-1 inline-flex max-w-xs items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted">
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span className="block truncate">{a.fileName}</span>
                <span className="block text-xs text-muted-foreground">{formatBytes(a.sizeBytes)}</span>
              </span>
              <Download className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </a>
          )
        ))}

        {/* Reaction chips */}
        {Object.keys(m.reactions).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(m.reactions).map(([emoji, who]) => (
              <button key={emoji} onClick={() => onReact(emoji)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  who.includes(me.employeeId) ? 'border-foreground/40 bg-muted' : 'border-border hover:bg-muted/60'
                }`}>
                <span>{emoji}</span><span className="text-muted-foreground">{who.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Reply-count link */}
        {!inThread && m.replyCount > 0 && onReply && (
          <button onClick={onReply} className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground">
            {m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'} →
          </button>
        )}
      </div>

      {/* Hover actions */}
      <div className="absolute -top-2 right-0 hidden items-center gap-0.5 rounded-lg border border-border bg-background p-0.5 shadow-sm group-hover:flex">
        <div className="relative">
          <button onClick={() => setShowEmoji(v => !v)} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="React">
            <SmilePlus className="h-3.5 w-3.5" />
          </button>
          {showEmoji && (
            <div className="absolute right-0 top-full z-20 mt-1 flex gap-0.5 rounded-lg border border-border bg-background p-1 shadow-lg">
              {QUICK_EMOJI.map(e => (
                <button key={e} onClick={() => { onReact(e); setShowEmoji(false) }}
                  className="rounded p-1 text-sm hover:bg-muted">{e}</button>
              ))}
            </div>
          )}
        </div>
        {!inThread && onQuote && (
          <button onClick={onQuote} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Reply (quote)">
            <CornerUpLeft className="h-3.5 w-3.5" />
          </button>
        )}
        {!inThread && onReply && (
          <button onClick={onReply} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Reply in thread">
            <Reply className="h-3.5 w-3.5" />
          </button>
        )}
        {canEdit && !editing && (
          <button onClick={beginEdit} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Edit message">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        {mine && (
          <button onClick={onDelete} className="rounded p-1 text-muted-foreground hover:text-destructive" aria-label="Delete message">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── Read receipts (sender-only UI) ───────────────────────────────────────────
// DM:    ✓✓ grey = delivered (stored + pushed) · ✓✓ dark = read.
//        True per-device "delivered" isn't knowable server-side; documented
//        approximation: a stored message is considered delivered.
// Group: ✓✓ + count; click opens the detailed list (names, designation, time
//        + who hasn't read). Detail endpoint re-verifies sender server-side.

function ReadTicks({ m, isDm, memberCount, mask }: {
  m: ChatMessage; isDm: boolean; memberCount: number
  mask: (name?: string | null, cqid?: string | null) => string
}) {
  const [open, setOpen] = useState(false)
  const others = Math.max(1, memberCount - 1)
  const readCount = m.readerIds.length
  const allRead = readCount >= others

  return (
    <span className="relative inline-flex items-center">
      <button
        onClick={() => setOpen(v => !v)}
        className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Read receipts"
        title={isDm ? (allRead ? 'Read' : 'Delivered') : `Read by ${readCount} of ${others}`}
      >
        {isDm ? (
          allRead
            ? <CheckCheck className="h-3.5 w-3.5 text-sky-500" />
            : <CheckCheck className="h-3.5 w-3.5" />
        ) : readCount === 0 ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <>
            <CheckCheck className={`h-3.5 w-3.5 ${allRead ? 'text-sky-500' : ''}`} />
            <span className="text-[10px] tabular-nums">{readCount}</span>
          </>
        )}
      </button>
      {open && <ReceiptsPopover messageId={m.id} onClose={() => setOpen(false)} mask={mask} />}
    </span>
  )
}

function ReceiptsPopover({ messageId, onClose, mask }: {
  messageId: string; onClose: () => void
  mask: (name?: string | null, cqid?: string | null) => string
}) {
  const [detail, setDetail] = useState<ReadReceiptDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await getReadReceipts(messageId)
      if (res.ok) setDetail(res.data)
      else setError(res.error)
    }, 0)
    return () => clearTimeout(t)
  }, [messageId])

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 top-5 z-40 w-64 rounded-xl border border-border bg-background p-3 shadow-xl">
        <p className="mb-2 text-xs font-semibold">Read receipts</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!detail && !error && <p className="animate-pulse text-xs text-muted-foreground">Loading…</p>}
        {detail && (
          <div className="space-y-2">
            {detail.readers.length > 0 && (
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Read by</p>
                {detail.readers.map(r => (
                  <div key={r.employeeId} className="flex items-center gap-2 py-0.5">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium">{initials(mask(r.name, r.cqid))}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{mask(r.name, r.cqid)}</span>
                      {r.designation && <span className="block truncate text-[10px] text-muted-foreground">{r.designation}</span>}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {new Date(r.readAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {detail.unread.length > 0 && (
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Not yet read</p>
                {detail.unread.map(u => (
                  <div key={u.employeeId} className="flex items-center gap-2 py-0.5 opacity-70">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium">{initials(mask(u.name, u.cqid))}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{mask(u.name, u.cqid)}</span>
                      {u.designation && <span className="block truncate text-[10px] text-muted-foreground">{u.designation}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {detail.readers.length === 0 && detail.unread.length === 0 && (
              <p className="text-xs text-muted-foreground">No other members.</p>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// ── Thread panel ──────────────────────────────────────────────────────────────

function ThreadPanel({ rootId, conversationId, me, members, onClose, onReplySent }: {
  rootId: string
  conversationId: string
  me: Me
  members: { employeeId: string; name: string; cqid: string }[]
  onClose: () => void
  onReplySent: () => void
}) {
  const [parent, setParent] = useState<ChatMessage | null>(null)
  const [replies, setReplies] = useState<ChatMessage[]>([])
  const [pending, startTransition] = useTransition()
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      startTransition(async () => {
        const res = await getThread(rootId)
        if (res.ok) { setParent(res.data.parent); setReplies(res.data.replies) }
      })
    }, 0)
    return () => clearTimeout(t)
  }, [rootId])

  useEffect(() => { endRef.current?.scrollIntoView() }, [replies.length])

  const { revealNames } = usePermissions()
  const nameOf = (m: ChatMessage) => {
    const member = members.find(x => x.employeeId === m.senderId)
    return displayEmployee(
      { name: m.senderName ?? member?.name ?? '', cqid: m.senderCqid ?? member?.cqid ?? '' },
      { revealNames, canReveal: true },
    )
  }

  const sendReply = (text: string) => {
    startTransition(async () => {
      const res = await sendMessage(conversationId, text, { parentId: rootId })
      if (res.ok) { setReplies(prev => [...prev, res.data]); onReplySent() }
      else alert(res.error)
    })
  }

  const react = (messageId: string, emoji: string) => {
    const apply = (list: ChatMessage[]) => list.map(m => {
      if (m.id !== messageId) return m
      const minehas = (m.reactions[emoji] ?? []).includes(me.employeeId)
      const next = { ...m.reactions }
      next[emoji] = minehas
        ? (next[emoji] ?? []).filter(id => id !== me.employeeId)
        : [...(next[emoji] ?? []), me.employeeId]
      if (next[emoji].length === 0) delete next[emoji]
      return { ...m, reactions: next }
    })
    setReplies(apply)
    setParent(p => (p ? apply([p])[0] : p))
    startTransition(async () => { await toggleReaction(messageId, emoji) })
  }

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-background md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-border">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold">Thread</p>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close thread">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {parent && (
          <>
            <MessageRow m={parent} me={me} senderName={nameOf(parent)} inThread
              onDelete={() => {}} onReact={e => react(parent.id, e)} />
            <div className="my-2 flex items-center gap-2">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</span>
              <div className="h-px flex-1 bg-border" />
            </div>
          </>
        )}
        {replies.map(m => (
          <MessageRow key={m.id} m={m} me={me} senderName={nameOf(m)} inThread
            onDelete={() => startTransition(async () => {
              await deleteMessage(m.id)
              setReplies(prev => prev.map(x => x.id === m.id ? { ...x, deletedAt: new Date().toISOString(), body: '' } : x))
            })}
            onReact={e => react(m.id, e)} />
        ))}
        <div ref={endRef} />
      </div>
      <Composer placeholder="Reply in thread…" members={members} disabled={pending} onSend={sendReply} />
    </aside>
  )
}

// ── List row + dialog (unchanged from Phase 1) ───────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>
}

function ConversationRow({ conv, active, onClick, onDelete, displayName, showName, indented }: {
  conv: ChatConversation; active: boolean; onClick: () => void
  /** Only passed when the server would actually allow this caller to delete. */
  onDelete?: (conv: ChatConversation, displayName: string) => void
  displayName: string
  showName: (name?: string | null, cqid?: string | null) => string
  /** Nested under a client channel — indented with a thread rail. */
  indented?: boolean
}) {
  // The row and the delete control are SIBLINGS, never nested. A button inside
  // a role="button" row swallows Enter/Space on the inner control (the outer
  // keydown handler preventDefaults it), so the confirm could never be
  // triggered from the keyboard.
  return (
    <div className={`group/row flex w-full items-center transition-colors ${
      active ? 'bg-muted' : 'hover:bg-muted/50'
    } ${indented ? 'pl-4' : ''}`}>
      {indented && <span aria-hidden className="ml-4 mr-1 h-6 w-px shrink-0 bg-border" />}
      <button onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-4 pr-1 text-left">
        {conv.type === 'dm'
          ? <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{initials(displayName)}</span>
          : conv.isPrivate ? <Lock className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Hash className={`${indented ? 'h-3 w-3' : 'h-4 w-4'} shrink-0 text-muted-foreground`} />}
        <span className="min-w-0 flex-1">
          <span className={`flex items-center gap-1.5 ${indented ? 'text-xs' : 'text-sm'}`}>
            <span className={`truncate ${conv.unread > 0 ? 'font-semibold' : ''}`}>{displayName}</span>
            {ENTITY_BADGE[conv.type] && (
              <span className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${ENTITY_BADGE[conv.type].cls}`}>
                {ENTITY_BADGE[conv.type].label}
              </span>
            )}
          </span>
          {conv.lastMessage && !indented && (
            <span className="block truncate text-xs text-muted-foreground">
              {(conv.lastMessage.senderCqid || conv.lastMessage.senderName)
                ? `${showName(conv.lastMessage.senderName, conv.lastMessage.senderCqid)}: ` : ''}{conv.lastMessage.body}
            </span>
          )}
        </span>
        {!conv.isMember && <span className="text-[10px] text-muted-foreground">join</span>}
        {conv.unread > 0 && (
          <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1.5 text-[10px] font-semibold text-background">
            {conv.unread > 99 ? '99+' : conv.unread}
          </span>
        )}
      </button>
      {onDelete && (
        <button
          onClick={() => onDelete(conv, displayName)}
          aria-label={`Delete ${displayName}`}
          title="Delete chat"
          className="mr-2 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-red-500 focus:opacity-100 group-hover/row:opacity-100">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function NewConversationDialog({ mode, canCreateChannels, onClose, onCreated }: {
  mode: 'channel' | 'dm'
  canCreateChannels: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const { revealNames } = usePermissions()
  const mask = (name?: string | null, cqid?: string | null) =>
    displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true })
  const [tab, setTab] = useState<'channel' | 'dm'>(mode === 'channel' && canCreateChannels ? 'channel' : 'dm')
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [category, setCategory] = useState<'general' | 'department' | 'client'>('general')
  const [clientId, setClientId] = useState('')
  const [clients, setClients] = useState<{ id: string; name: string }[]>([])
  const [employees, setEmployees] = useState<{ id: string; name: string; cqid: string }[]>([])
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    listChatEmployees().then(res => { if (res.ok) setEmployees(res.data) })
    listClientsForChat().then(res => { if (res.ok) setClients(res.data) })
  }, [])

  // Picking a client auto-names the channel after them.
  const pickClient = (id: string) => {
    setClientId(id)
    const c = clients.find(x => x.id === id)
    if (c) setName(c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40))
  }

  const filtered = employees.filter(e =>
    !filter || e.name.toLowerCase().includes(filter.toLowerCase()) || e.cqid.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-1 rounded-lg bg-muted p-0.5">
            {canCreateChannels && (
              <button onClick={() => setTab('channel')}
                className={`rounded-md px-3 py-1 text-xs font-medium ${tab === 'channel' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>
                Channel
              </button>
            )}
            <button onClick={() => setTab('dm')}
              className={`rounded-md px-3 py-1 text-xs font-medium ${tab === 'dm' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>
              Direct message
            </button>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}

        {tab === 'channel' ? (
          <div className="space-y-3">
            {/* Category: General / Department / Client */}
            <div className="flex gap-1 rounded-lg bg-muted p-0.5">
              {([['general', 'General'], ['department', 'Department'], ['client', 'Client']] as const).map(([key, label]) => (
                <button key={key} onClick={() => setCategory(key)}
                  className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${category === key ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}>
                  {label}
                </button>
              ))}
            </div>

            {category === 'client' && (
              <select value={clientId} onChange={e => pickClient(e.target.value)}
                className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40">
                <option value="">Choose client…</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}

            <input value={name} onChange={e => setName(e.target.value)}
              placeholder={category === 'department' ? 'design-team' : category === 'client' ? 'auto-named from client' : 'channel-name'}
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="Topic (optional)"
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} />
              Private (invite-only)
            </label>
            <button
              disabled={!name.trim() || pending || (category === 'client' && !clientId)}
              onClick={() => startTransition(async () => {
                const res = await createChannel({
                  name, topic, isPrivate, category,
                  clientId: category === 'client' ? clientId : null,
                })
                if (res.ok) onCreated(res.data.id); else setError(res.error)
              })}
              className="w-full rounded-lg bg-foreground py-2 text-sm font-medium text-background disabled:opacity-40">
              {pending ? 'Creating…' : category === 'client' ? 'Create client channel' : category === 'department' ? 'Create department channel' : 'Create channel'}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search people…"
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
              {filtered.map(e => (
                <button key={e.id}
                  onClick={() => startTransition(async () => {
                    const res = await getOrCreateDm(e.id)
                    if (res.ok) onCreated(res.data.id); else setError(res.error)
                  })}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{initials(mask(e.name, e.cqid))}</span>
                  <span className="text-sm">{mask(e.name, e.cqid)}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{e.cqid}</span>
                </button>
              ))}
              {filtered.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No people found.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function WorkNavigatorRow({ conv, active, onClick, isPinned, togglePin }: {
  conv: ChatConversation; active: boolean; onClick: () => void;
  isPinned: boolean; togglePin: (e: React.MouseEvent) => void;
}) {
  const badge = ENTITY_BADGE[conv.type]
  const Icon = badge?.Icon ?? Hash
  const displayName = conv.name || 'Untitled'

  return (
    <div className={`group/row flex w-full items-center transition-colors ${active ? 'bg-muted' : 'hover:bg-muted/50'}`}>
      <button onClick={onClick} className="flex min-w-0 flex-1 items-start gap-3 py-2 pl-4 pr-1 text-left">
        <div className="mt-0.5"><Icon className={`h-4 w-4 shrink-0 ${badge ? badge.cls.split(' ')[1] : 'text-muted-foreground'}`} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate text-sm ${conv.unread > 0 ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'}`}>{displayName}</span>
            {conv.unread > 0 && (
              <span className="shrink-0 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold text-background">
                {conv.unread > 99 ? '99+' : conv.unread}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            {badge && <span className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${badge.cls}`}>{badge.label}</span>}
            {conv.topic && <span className="truncate text-xs text-muted-foreground">{conv.topic}</span>}
          </div>
        </div>
      </button>
      <button onClick={togglePin} className={`mr-2 shrink-0 rounded p-1.5 transition-opacity hover:text-foreground ${isPinned ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-0 group-hover/row:opacity-100 focus:opacity-100'}`}>
        <Pin className={`h-3.5 w-3.5 ${isPinned ? 'fill-current' : ''}`} />
      </button>
    </div>
  )
}

function WorkNavigatorPanel({
  clientGroup, activeId, filter, search, pinnedIds,
  setFilter, setSearch, togglePin, onSelect, onClose
}: {
  clientGroup: { name: string; threads: ChatConversation[] }
  activeId: string | null
  filter: string
  search: string
  pinnedIds: string[]
  setFilter: (f: string) => void
  setSearch: (s: string) => void
  togglePin: (id: string, e: React.MouseEvent) => void
  onSelect: (id: string) => void
  onClose?: () => void
}) {
  const threads = useMemo(() => {
    let list = clientGroup.threads
    if (filter !== 'All') {
      const typeMap: Record<string, string> = { Tasks: 'task', Campaigns: 'project', Plans: 'plan' }
      const t = typeMap[filter]
      if (t) list = list.filter(x => x.type === t)
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(x => x.name?.toLowerCase().includes(q) || x.topic?.toLowerCase().includes(q))
    }
    return [...list].sort((a, b) => {
      const pA = pinnedIds.includes(a.id)
      const pB = pinnedIds.includes(b.id)
      if (pA && !pB) return -1
      if (!pA && pB) return 1
      const timeA = a.lastMessage?.createdAt ?? ''
      const timeB = b.lastMessage?.createdAt ?? ''
      return timeB.localeCompare(timeA)
    })
  }, [clientGroup.threads, filter, search, pinnedIds])

  const pinned = threads.filter(t => pinnedIds.includes(t.id))
  const unpinned = threads.filter(t => !pinnedIds.includes(t.id))
  
  const grouped = {
    Tasks: unpinned.filter(t => t.type === 'task'),
    Campaigns: unpinned.filter(t => t.type === 'project'),
    Plans: unpinned.filter(t => t.type === 'plan'),
    Requests: unpinned.filter(t => t.type === 'request'),
    Other: unpinned.filter(t => !['task', 'project', 'plan', 'request'].includes(t.type))
  }

  return (
    <>
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold truncate">{clientGroup.name} Work</h2>
        {onClose && (
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground md:hidden" aria-label="Close Work Navigator">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="border-b border-border px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search discussions…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          {search && (
            <button onClick={() => setSearch('')} aria-label="Clear search"><X className="h-3.5 w-3.5 text-muted-foreground" /></button>
          )}
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
          {['All', 'Tasks', 'Campaigns', 'Plans'].map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${filter === f ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:bg-muted/80'}`}>
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {threads.length === 0 && <p className="px-4 py-2 text-xs text-muted-foreground">No discussions found.</p>}
        {pinned.length > 0 && (
          <div className="mb-4">
            <SectionLabel>📌 Pinned</SectionLabel>
            {pinned.map(t => <WorkNavigatorRow key={t.id} conv={t} active={t.id === activeId} onClick={() => onSelect(t.id)} isPinned togglePin={e => togglePin(t.id, e)} />)}
          </div>
        )}
        {Object.entries(grouped).map(([label, list]) => list.length > 0 && (
          <div key={label} className="mb-4">
            <SectionLabel>{label}</SectionLabel>
            {list.map(t => <WorkNavigatorRow key={t.id} conv={t} active={t.id === activeId} onClick={() => onSelect(t.id)} isPinned={false} togglePin={e => togglePin(t.id, e)} />)}
          </div>
        ))}
      </div>
    </>
  )
}

function MembersDialog({ conversation, me, onClose }: {
  conversation: ChatConversation
  me: { employeeId: string; name: string; cqid: string }
  onClose: () => void
}) {
  const { revealNames } = usePermissions()
  const mask = (name?: string | null, cqid?: string | null) =>
    displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true })

  const [tab, setTab] = useState<'members' | 'add'>('members')
  const [employees, setEmployees] = useState<{ id: string; name: string; cqid: string }[]>([])
  const [filter, setFilter] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listChatEmployees().then(res => { if (res.ok) setEmployees(res.data) })
  }, [])

  const existingIds = new Set(conversation.members.map(m => m.employeeId))
  const addable = employees.filter(e => !existingIds.has(e.id))
  
  const filteredMembers = conversation.members.filter(m => 
    !filter || m.name?.toLowerCase().includes(filter.toLowerCase()) || m.cqid?.toLowerCase().includes(filter.toLowerCase()))
    
  const filteredAddable = addable.filter(e => 
    !filter || e.name.toLowerCase().includes(filter.toLowerCase()) || e.cqid.toLowerCase().includes(filter.toLowerCase()))

  const myMembership = conversation.members.find(m => m.employeeId === me.employeeId)
  
  const canRemove = (targetId: string, targetRole: string) => {
    if (targetId === me.employeeId) return true // can leave
    if (myMembership?.role === 'owner' && targetRole !== 'owner') return true
    if (myMembership?.role === 'moderator' && targetRole === 'member') return true
    return false
  }

  const RoleBadge = ({ role }: { role: string }) => {
    if (role === 'owner') return <span className="text-[10px] uppercase font-semibold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">👑 Owner</span>
    if (role === 'moderator') return <span className="text-[10px] uppercase font-semibold text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded">🛡️ Admin</span>
    return <span className="text-[10px] uppercase font-semibold text-muted-foreground bg-muted px-1.5 py-0.5 rounded">👤 Member</span>
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-xl flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-1 rounded-lg bg-muted p-0.5">
            <button onClick={() => { setTab('members'); setFilter('') }}
              className={`rounded-md px-3 py-1 text-xs font-medium ${tab === 'members' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              Members ({conversation.members.length})
            </button>
            {conversation.type !== 'dm' && (
              <button onClick={() => { setTab('add'); setFilter('') }}
                className={`rounded-md px-3 py-1 text-xs font-medium ${tab === 'add' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                Add People
              </button>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="mb-3 text-xs text-destructive">{error}</p>}

        <div className="mb-3 relative">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search..."
            className="w-full rounded-lg border border-border bg-transparent pl-9 pr-3 py-2 text-sm outline-none focus:border-foreground/40" />
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 space-y-0.5 -mx-2 px-2 scrollbar-thin">
          {tab === 'members' ? (
            <>
              {filteredMembers.map(m => (
                <div key={m.employeeId} className="flex items-center gap-3 rounded-lg p-2 hover:bg-muted/50 transition-colors">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {initials(mask(m.name, m.cqid))}
                  </span>
                  <div className="min-w-0 flex-1 flex flex-col justify-center">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{mask(m.name, m.cqid)}</span>
                      {m.employeeId === me.employeeId && <span className="text-[10px] text-muted-foreground">(You)</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">{m.cqid}</span>
                      <RoleBadge role={m.role} />
                    </div>
                  </div>
                  {canRemove(m.employeeId, m.role) && (
                    <button 
                      disabled={pending}
                      onClick={() => {
                        if (m.employeeId !== me.employeeId && !confirm(`Remove ${mask(m.name, m.cqid)} from this conversation?`)) return;
                        if (m.employeeId === me.employeeId && !confirm(`Are you sure you want to leave this conversation?`)) return;
                        
                        startTransition(async () => {
                          setError(null)
                          const res = await removeMemberFromConversation(conversation.id, m.employeeId)
                          if (!res.ok) setError(res.error)
                          else if (m.employeeId === me.employeeId) onClose() // Close if self left
                        })
                      }}
                      className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-50">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
              {filteredMembers.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">No members found.</p>}
            </>
          ) : (
            <>
              {employees.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">Loading...</p>
              ) : filteredAddable.length === 0 ? (
                <p className="p-4 text-center text-sm text-muted-foreground">No matching people to add.</p>
              ) : (
                filteredAddable.map(e => (
                  <div key={e.id} className="flex items-center gap-3 rounded-lg p-2 hover:bg-muted/50 transition-colors">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {initials(mask(e.name, e.cqid))}
                    </span>
                    <div className="min-w-0 flex-1 flex flex-col justify-center">
                      <span className="truncate text-sm font-medium">{mask(e.name, e.cqid)}</span>
                      <span className="text-xs text-muted-foreground mt-0.5">{e.cqid}</span>
                    </div>
                    <button 
                      disabled={pending}
                      onClick={() => startTransition(async () => {
                        setError(null)
                        const res = await addMembersToConversation(conversation.id, [e.id])
                        if (!res.ok) setError(res.error)
                      })}
                      className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-50">
                      Add
                    </button>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
