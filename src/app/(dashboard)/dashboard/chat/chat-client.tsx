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
  CornerUpLeft, Mic, Check, CheckCheck,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ApprovalCard } from '@/components/approvals/approval-card'
import { VoiceRecorderButton, VoiceBubble, type VoiceRecording } from '@/components/chat/voice'
import { RequestApprovalDialog } from '@/components/approvals/request-approval-dialog'
import {
  listConversations, createChannel, getOrCreateDm, joinChannel,
  listChatEmployees, getMessages, getThread, sendMessage, deleteMessage, markRead,
  toggleReaction, createAttachmentUploadUrl, sendFileMessage, searchMessages,
  sendVoiceMessage, getMessage, getReadReceipts,
  type ChatConversation, type ChatMessage, type ChatSearchHit, type ReplySnapshot, type ReadReceiptDetail,
} from './actions'

const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '✅', '👀']

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

  // ── Realtime: the open conversation's messages ─────────────────────────────
  useEffect(() => {
    if (!activeId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`conv:${activeId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${activeId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          if (row.conversation_id !== activeId) return
          if (row.parent_id) return // thread replies render in the thread panel
          setMessages(prev => {
            if (prev.some(m => m.id === row.id)) return prev
            return [...prev, {
              id: String(row.id),
              conversationId: String(row.conversation_id),
              senderId: (row.sender_id as string | null) ?? null,
              senderName: row.sender_id === me.employeeId ? me.name : null,
              senderCqid: null,
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
            }]
          })
          if (row.sender_id !== me.employeeId) void markRead(activeId)
          // Voice/file messages need signed attachment URLs — hydrate fully.
          if (row.kind !== 'text' && row.sender_id !== me.employeeId) {
            void getMessage(String(row.id)).then(res => {
              if (res.ok) setMessages(prev => prev.map(m => (m.id === res.data.id ? res.data : m)))
            })
          }
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'message_reads', filter: `conversation_id=eq.${activeId}` },
        (payload) => {
          const row = payload.new as { message_id?: string; employee_id?: string }
          if (!row.message_id || !row.employee_id) return
          // Only meaningful on my own messages (receipts are sender-visible)
          setMessages(prev => prev.map(m =>
            m.id === row.message_id && m.senderId === me.employeeId && !m.readerIds.includes(row.employee_id!)
              ? { ...m, readerIds: [...m.readerIds, row.employee_id!] }
              : m))
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${activeId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>
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
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [activeId, me.employeeId, me.name])

  const memberNames = useMemo(() => {
    const map = new Map<string, string>()
    active?.members.forEach(m => map.set(m.employeeId, m.name || m.cqid))
    return map
  }, [active])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length])

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleSendRoot = useCallback((text: string) => {
    if (!activeId) return
    const replyToId = replyTo?.id ?? null
    setReplyTo(null)
    startTransition(async () => {
      const res = await sendMessage(activeId, text, { replyToId })
      if (res.ok) setMessages(prev => (prev.some(m => m.id === res.data.id) ? prev : [...prev, res.data]))
      else alert(res.error)
    })
  }, [activeId, replyTo])

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

  const channels = conversations.filter(c => c.type === 'channel' || c.type === 'group')
  const dms      = conversations.filter(c => c.type === 'dm')

  return (
    <div className="flex h-full">
      {/* ── Pane 1: list + search ── */}
      <aside className={`${activeId ? 'hidden md:flex' : 'flex'} w-full md:w-72 shrink-0 flex-col border-r border-border bg-background`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
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
                    {hit.senderName ? `${hit.senderName}: ` : ''}{hit.snippet}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <>
              <SectionLabel>Channels</SectionLabel>
              {channels.map(c => (
                <ConversationRow key={c.id} conv={c} active={c.id === activeId}
                  onClick={() => (c.isMember ? openConversation(c.id) : handleJoin(c.id))} />
              ))}
              {canCreateChannels && (
                <button onClick={() => setShowNewMenu('channel')}
                  className="flex w-full items-center gap-2 px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                  <Plus className="h-3.5 w-3.5" /> New channel
                </button>
              )}

              <SectionLabel>Direct messages</SectionLabel>
              {dms.map(c => (
                <ConversationRow key={c.id} conv={c} active={c.id === activeId}
                  onClick={() => openConversation(c.id)} />
              ))}
              {dms.length === 0 && (
                <p className="px-4 py-1 text-xs text-muted-foreground">No direct messages yet.</p>
              )}
            </>
          )}
        </div>
      </aside>

      {/* ── Pane 2: thread ── */}
      <section className={`${activeId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-background`}>
        {!active ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <MessageSquare className="h-8 w-8" />
            <p className="text-sm">Pick a conversation, or start a new one.</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <button onClick={() => setActiveId(null)} className="md:hidden rounded p-1 text-muted-foreground" aria-label="Back">
                <ArrowLeft className="h-4 w-4" />
              </button>
              {active.type === 'dm'
                ? <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium">{initials(active.name ?? '')}</span>
                : active.isPrivate ? <Lock className="h-4 w-4 text-muted-foreground" /> : <Hash className="h-4 w-4 text-muted-foreground" />}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{active.name}</p>
                {active.topic && <p className="truncate text-xs text-muted-foreground">{active.topic}</p>}
              </div>
              <span className="ml-auto inline-flex items-center gap-2">
                <button onClick={() => setShowApprovalDialog(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  title="Request approval in this conversation">
                  <ClipboardCheck className="h-3.5 w-3.5" /> Approval
                </button>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Users2 className="h-3.5 w-3.5" /> {active.members.length}
                </span>
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
                      senderName={m.senderName ?? (m.senderId ? memberNames.get(m.senderId) ?? '…' : 'System')}
                      isDm={active.type === 'dm'}
                      memberCount={active.members.length}
                      highlighted={highlightId === m.id}
                      onDelete={() => startTransition(async () => { await deleteMessage(m.id) })}
                      onReact={emoji => handleReact(m.id, emoji)}
                      onReply={() => setThreadRootId(m.id)}
                      onQuote={() => setReplyTo(m)}
                      onJumpTo={jumpToMessage}
                    />
                  ))}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            <Composer
              placeholder={`Message ${active.type === 'dm' ? active.name : `#${active.name}`}`}
              members={active.members.filter(m => m.employeeId !== me.employeeId)}
              disabled={pending}
              onSend={handleSendRoot}
              onFile={handleUpload}
              onVoice={handleVoice}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
            />
          </>
        )}
      </section>

      {/* ── Pane 3: reply thread ── */}
      {threadRootId && activeId && (
        <ThreadPanel
          rootId={threadRootId}
          conversationId={activeId}
          me={me}
          members={active?.members ?? []}
          onClose={() => setThreadRootId(null)}
          onReplySent={() => {
            // bump the reply count on the root message
            setMessages(prev => prev.map(m => m.id === threadRootId ? { ...m, replyCount: m.replyCount + 1 } : m))
          }}
        />
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
    </div>
  )
}

// ── Composer (shared by main thread + reply panel) ───────────────────────────

function Composer({ placeholder, members, disabled, onSend, onFile, onVoice, replyTo, onCancelReply }: {
  placeholder: string
  members: { employeeId: string; name: string; cqid: string }[]
  disabled: boolean
  onSend: (text: string) => void
  onFile?: (file: File) => void
  onVoice?: (rec: VoiceRecording) => void
  replyTo?: ChatMessage | null
  onCancelReply?: () => void
}) {
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
    const next = `${draft.slice(0, at)}@${m.name || m.cqid} ${draft.slice(caret)}`
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
              Replying to {replyTo.senderName ?? 'message'}
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
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{initials(m.name)}</span>
              <span className="text-sm">{m.name}</span>
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

function MessageRow({ m, me, senderName, onDelete, onReact, onReply, onQuote, onJumpTo, isDm = false, memberCount = 2, highlighted = false, inThread = false }: {
  m: ChatMessage
  me: Me
  senderName: string
  onDelete: () => void
  onReact: (emoji: string) => void
  onReply?: () => void
  onQuote?: () => void
  onJumpTo?: (messageId: string) => void
  isDm?: boolean
  memberCount?: number
  highlighted?: boolean
  inThread?: boolean
}) {
  const [showEmoji, setShowEmoji] = useState(false)
  const mine = m.senderId === me.employeeId
  const replySnap = (m.metadata.replyTo ?? null) as ReplySnapshot | null
  const replyUnavailable = m.metadata.replyToUnavailable === true

  if (m.deletedAt) {
    return <p className="py-1 pl-10 text-xs italic text-muted-foreground">Message deleted</p>
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
            <ReadTicks m={m} isDm={isDm} memberCount={memberCount} />
          )}
        </p>
        {replySnap && (
          <button
            onClick={() => !replyUnavailable && onJumpTo?.(replySnap.messageId)}
            className={`mb-1 flex w-full max-w-sm items-center gap-2 rounded-lg border-l-2 border-l-foreground/50 bg-muted/50 px-2.5 py-1.5 text-left ${replyUnavailable ? 'cursor-default opacity-70' : 'hover:bg-muted'}`}>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] font-medium text-foreground/80">{replySnap.senderName}</span>
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
          />
        ) : m.kind === 'approval' && typeof m.metadata.approvalId === 'string' ? (
          <ApprovalCard
            approvalId={m.metadata.approvalId}
            statusHint={typeof m.metadata.approvalStatus === 'string' ? m.metadata.approvalStatus : undefined}
            meId={me.employeeId}
          />
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

function ReadTicks({ m, isDm, memberCount }: { m: ChatMessage; isDm: boolean; memberCount: number }) {
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
      {open && <ReceiptsPopover messageId={m.id} onClose={() => setOpen(false)} />}
    </span>
  )
}

function ReceiptsPopover({ messageId, onClose }: { messageId: string; onClose: () => void }) {
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
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium">{initials(r.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{r.name}</span>
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
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium">{initials(u.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{u.name}</span>
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

  const nameOf = (m: ChatMessage) =>
    m.senderName ?? members.find(x => x.employeeId === m.senderId)?.name ?? '…'

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

function ConversationRow({ conv, active, onClick }: {
  conv: ChatConversation; active: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-2 px-4 py-2 text-left transition-colors ${
        active ? 'bg-muted' : 'hover:bg-muted/50'
      }`}>
      {conv.type === 'dm'
        ? <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{initials(conv.name ?? '')}</span>
        : conv.isPrivate ? <Lock className="h-4 w-4 shrink-0 text-muted-foreground" /> : <Hash className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-sm ${conv.unread > 0 ? 'font-semibold' : ''}`}>{conv.name}</span>
        {conv.lastMessage && (
          <span className="block truncate text-xs text-muted-foreground">
            {conv.lastMessage.senderName ? `${conv.lastMessage.senderName.split(' ')[0]}: ` : ''}{conv.lastMessage.body}
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
  )
}

function NewConversationDialog({ mode, canCreateChannels, onClose, onCreated }: {
  mode: 'channel' | 'dm'
  canCreateChannels: boolean
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [tab, setTab] = useState<'channel' | 'dm'>(mode === 'channel' && canCreateChannels ? 'channel' : 'dm')
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPrivate, setIsPrivate] = useState(false)
  const [employees, setEmployees] = useState<{ id: string; name: string; cqid: string }[]>([])
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    listChatEmployees().then(res => { if (res.ok) setEmployees(res.data) })
  }, [])

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
            <input value={name} onChange={e => setName(e.target.value)} placeholder="channel-name"
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="Topic (optional)"
              className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/40" />
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} />
              Private (invite-only)
            </label>
            <button
              disabled={!name.trim() || pending}
              onClick={() => startTransition(async () => {
                const res = await createChannel({ name, topic, isPrivate })
                if (res.ok) onCreated(res.data.id); else setError(res.error)
              })}
              className="w-full rounded-lg bg-foreground py-2 text-sm font-medium text-background disabled:opacity-40">
              {pending ? 'Creating…' : 'Create channel'}
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
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium">{initials(e.name)}</span>
                  <span className="text-sm">{e.name}</span>
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
