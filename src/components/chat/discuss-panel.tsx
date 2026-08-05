'use client'

/**
 * <DiscussPanel> — an Odoo-chatter-style slide-over for an entity's discussion
 * room. Opens in place on the page the entity lives on (task modal, request
 * detail, social-calendar plan) so a quick note never costs a navigation.
 *
 * Deliberately lightweight: text messages only, day-grouped, live via one
 * per-conversation realtime subscription. Voice notes / files / approvals
 * render as summary chips with an "Open in Chat" escape hatch — the full chat
 * page stays the home of the heavy features (threads, reactions, receipts).
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { X, ExternalLink, SendHorizonal, Loader2, MessageSquare, Mic, Paperclip, ClipboardCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import {
  getOrCreateEntityConversation, getMessages, getMessage, sendMessage, markRead,
  type ChatMessage, type DiscussEntityType,
} from '@/app/(dashboard)/dashboard/chat/actions'

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const that = new Date(d); that.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - that.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: that.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

const KIND_CHIP: Record<string, { icon: typeof Mic; label: string }> = {
  voice:    { icon: Mic,            label: 'Voice note' },
  file:     { icon: Paperclip,      label: 'Attachment' },
  approval: { icon: ClipboardCheck, label: 'Approval request' },
}

export function DiscussPanel({ entityType, entityId, title, onClose }: {
  entityType: DiscussEntityType
  entityId: string
  /** Header label — e.g. the task title or "Elara Luxe Perfume — Aug 2026". */
  title?: string
  onClose: () => void
}) {
  const router = useRouter()
  const { revealNames } = usePermissions()
  const showName = useCallback(
    (name?: string | null, cqid?: string | null) =>
      displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true }),
    [revealNames],
  )

  const [convId, setConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, startSend] = useTransition()
  const [mounted, setMounted] = useState(false)
  const feedRef = useRef<HTMLDivElement | null>(null)

  // createPortal needs a real document — defer past SSR/hydration.
  useEffect(() => { setMounted(true) }, [])

  const scrollToBottom = useCallback(() => {
    // Defer so the new row has painted before we measure.
    setTimeout(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }) }, 0)
  }, [])

  /** Insert keeping createdAt order — realtime rows resolve through an async
   *  round-trip, so they can arrive out of order and would otherwise render
   *  under the wrong day divider. */
  const mergeMessage = useCallback((m: ChatMessage) => {
    setMessages(prev => {
      if (prev.some(x => x.id === m.id)) return prev
      const next = [...prev, m]
      next.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      return next
    })
  }, [])

  // Open (or create) the room, load the tail of the feed, mark it read.
  useEffect(() => {
    let cancelled = false
    // Reset first: the panel stays mounted while the host page can swap the
    // entity under it (Back/Forward between plans). Without this the feed and
    // convId stay on the OLD room while the header shows the new one — the
    // composer would post into the wrong discussion.
    setConvId(null)
    setMessages([])
    setLoadError(null)
    ;(async () => {
      const res = await getOrCreateEntityConversation(entityType, entityId)
      if (cancelled) return
      if (!res.ok) { setLoadError(res.error); return }
      const msgs = await getMessages(res.data.id)
      if (cancelled) return
      if (!msgs.ok) { setLoadError(msgs.error); return }
      // convId is set only once the history is in hand, so the composer can
      // never send into a room whose messages failed to load.
      setMessages(msgs.data.messages)
      setConvId(res.data.id)
      setLoadError(null)
      scrollToBottom()
      void markRead(res.data.id)
    })()
    return () => { cancelled = true }
  }, [entityType, entityId, scrollToBottom])

  // Live inserts for this one conversation. RLS authorizes the stream.
  useEffect(() => {
    if (!convId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`discuss-panel-${crypto.randomUUID()}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          if (row.parent_id) return // thread replies live in the full chat page
          // The realtime row carries no sender join — fetch the mapped message
          // (CQID, kind, metadata) through the same read path the feed uses.
          void getMessage(String(row.id)).then(res => {
            if (!res.ok) return
            mergeMessage(res.data)
            scrollToBottom()
            void markRead(convId)
          })
        })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [convId, scrollToBottom, mergeMessage])

  // Escape closes the panel — and stops there. Without this the event reaches
  // the host modal's document-level listener and closes the whole task modal,
  // taking the panel and the unsent draft with it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true) // capture: beat the host
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const handleSend = () => {
    const text = draft.trim()
    if (!text || !convId) return
    setDraft('')
    startSend(async () => {
      const res = await sendMessage(convId, text)
      if (!res.ok) {
        // Restore only into an empty box — the user may have typed the next
        // message while this one was in flight, and that must not be clobbered.
        setDraft(prev => (prev.trim() ? prev : text))
        setLoadError(res.error)
        return
      }
      setLoadError(null)
      mergeMessage(res.data)
      scrollToBottom()
    })
  }

  // Day-grouped feed
  const grouped: { label: string; rows: ChatMessage[] }[] = []
  for (const m of messages) {
    const label = dayLabel(m.createdAt)
    const last = grouped[grouped.length - 1]
    if (last && last.label === label) last.rows.push(m)
    else grouped.push({ label, rows: [m] })
  }

  if (!mounted) return null

  // Portalled to <body>: mounts live inside headings and modal subtrees, where
  // an inline <aside role="dialog"> would be invalid HTML and would inherit the
  // host's stacking context.
  return createPortal(
    <>
      {/* Backdrop — mobile only. On desktop the page must stay clickable: a
          transparent full-screen catcher would swallow the first click on
          everything behind it, which is the opposite of a chatter panel. */}
      <div className="fixed inset-0 z-[140] bg-black/30 md:hidden" onClick={onClose} />

      <aside
        className="fixed inset-y-0 right-0 z-[150] flex w-full max-w-[400px] flex-col border-l border-border bg-background shadow-2xl"
        role="dialog" aria-label="Discussion panel"
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <MessageSquare className="h-4 w-4 shrink-0 text-violet-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{title || 'Discussion'}</p>
            <p className="text-[11px] text-muted-foreground capitalize">{entityType} discussion</p>
          </div>
          <button
            onClick={() => convId && router.push(`/dashboard/chat?c=${convId}`)}
            disabled={!convId}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Open in the full chat page (threads, voice, files)">
            <ExternalLink className="h-3 w-3" /> Open in Chat
          </button>
          <button onClick={onClose} aria-label="Close discussion panel"
            className="rounded p-1.5 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Feed */}
        <div ref={feedRef} className="flex-1 overflow-y-auto px-4 py-3">
          {loadError && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{loadError}</p>
          )}
          {!loadError && !convId && (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {convId && messages.length === 0 && !loadError && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <MessageSquare className="h-7 w-7" />
              <p className="text-xs">No messages yet — start the discussion.</p>
            </div>
          )}
          {grouped.map(g => (
            <div key={g.label}>
              <div className="my-3 flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] text-muted-foreground">{g.label}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
              {g.rows.map(m => {
                const chip = KIND_CHIP[m.kind]
                return (
                  <div key={m.id} className="mb-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold">
                        {m.senderId ? showName(m.senderName, m.senderCqid) || '…' : 'System'}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{timeLabel(m.createdAt)}</span>
                    </div>
                    {m.deletedAt ? (
                      <p className="text-xs italic text-muted-foreground">Message deleted</p>
                    ) : chip ? (
                      <button
                        onClick={() => convId && router.push(`/dashboard/chat?c=${convId}`)}
                        className="mt-0.5 inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                        title="Open in the full chat page">
                        <chip.icon className="h-3 w-3" /> {chip.label}
                      </button>
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{m.body}</p>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        {/* Composer — pr-16 keeps the send button clear of the app's global
            floating chat-bubble, which sits fixed in the bottom-right corner
            exactly where this button would otherwise land. */}
        <div className="border-t border-border p-3 pr-16">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
              }}
              rows={1}
              placeholder={convId ? 'Write a message… (Enter to send)' : 'Opening discussion…'}
              disabled={!convId}
              className="max-h-32 min-h-[38px] flex-1 resize-y rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm focus:border-violet-500/50 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!convId || sending || !draft.trim()}
              aria-label="Send message"
              className="rounded-lg bg-violet-600 p-2.5 text-white transition-colors hover:bg-violet-500 disabled:opacity-40">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizonal className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </aside>
    </>,
    document.body,
  )
}
