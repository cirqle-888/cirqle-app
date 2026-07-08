'use client'

/**
 * FloatingCommsWidget — an app-wide chat + alerts popup.
 *
 * A launcher button (bottom-right) with a combined unread badge (chat + bell
 * notifications). Opens a compact panel with two tabs:
 *   • Chat   — conversation list → tap into a lightweight thread + composer.
 *   • Alerts — the notification feed (mark-read, click-through).
 *
 * Runs everywhere in the dashboard (so it's available in the Cirqle Desktop
 * app too, which loads this same web app). Realtime is always live while
 * mounted — new messages/notifications bump the badge and slide in a toast
 * even when the panel is closed, which also removes the old 30s/60s poll lag
 * for anything shown here.
 *
 * Full chat features (threads, reactions, voice, files, search) stay on the
 * dedicated /dashboard/chat page; this is the quick "peek + reply" surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { MessageCircle, Bell, X, ArrowLeft, Send, Hash, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import {
  listConversations, getMessages, sendMessage, markRead,
  type ChatConversation, type ChatMessage,
} from '@/app/(dashboard)/dashboard/chat/actions'
import {
  getMyNotifications, markNotificationRead, markAllNotificationsRead,
  type NotificationRow,
} from '@/app/api/notifications/actions'

type Tab = 'chat' | 'alerts'

function timeLabel(iso: string): string {
  const d = new Date(iso)
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function previewOf(kind: string, body: string): string {
  if (kind === 'voice') return '🎤 Voice message'
  if (kind === 'file') return '📎 File'
  if (kind === 'approval') return '🟡 Approval request'
  return body || ''
}

export function FloatingCommsWidget() {
  const { user, revealNames } = usePermissions()
  const employeeId = user.employeeId
  const router = useRouter()

  const mask = useCallback(
    (name?: string | null, cqid?: string | null) =>
      displayEmployee({ name: name ?? '', cqid: cqid ?? '' }, { revealNames, canReveal: true }),
    [revealNames],
  )
  // DM titles arrive as "CQID||Name" — split then mask per privacy rules.
  const convTitle = useCallback((c: ChatConversation): string => {
    if (c.type === 'dm' && c.name?.includes('||')) {
      const [cqid, name] = c.name.split('||')
      return mask(name, cqid)
    }
    return c.name ?? 'Conversation'
  }, [mask])

  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')
  const [convs, setConvs] = useState<ChatConversation[]>([])
  const [notifs, setNotifs] = useState<NotificationRow[]>([])
  const [notifUnread, setNotifUnread] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [loadingThread, setLoadingThread] = useState(false)
  const [, startTransition] = useTransition()
  const [toast, setToast] = useState<{ title: string; body: string; onClick: () => void } | null>(null)

  const activeIdRef = useRef<string | null>(null)
  const openRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => { openRef.current = open }, [open])

  const chatUnread = useMemo(() => convs.reduce((s, c) => s + (c.unread || 0), 0), [convs])
  const totalBadge = chatUnread + notifUnread

  // ── Initial + light background refresh of the lists ──────────────────────────
  const refreshConvs = useCallback(async () => {
    const res = await listConversations()
    if (res.ok) setConvs(res.data.filter(c => c.isMember).sort(
      (a, b) => (b.lastMessage?.createdAt ?? '').localeCompare(a.lastMessage?.createdAt ?? '')))
  }, [])
  const refreshNotifs = useCallback(async () => {
    const res = await getMyNotifications(20)
    if (res.ok && res.data) { setNotifs(res.data.rows); setNotifUnread(res.data.unreadCount) }
  }, [])

  const openConversation = useCallback(async (convId: string) => {
    setActiveId(convId)
    setLoadingThread(true)
    setMessages([])
    const res = await getMessages(convId)
    setLoadingThread(false)
    if (res.ok) setMessages([...res.data.messages].reverse()) // API returns newest-first
    void markRead(convId)
    setConvs(prev => prev.map(c => c.id === convId ? { ...c, unread: 0 } : c))
  }, [])

  useEffect(() => {
    // Kick off the first load on the next tick (avoids a sync setState in the
    // effect body per the react-compiler rule) + a slow fallback refresh.
    const t = setTimeout(() => { void refreshConvs(); void refreshNotifs() }, 0)
    const id = setInterval(() => { void refreshConvs(); void refreshNotifs() }, 120_000)
    return () => { clearTimeout(t); clearInterval(id) }
  }, [refreshConvs, refreshNotifs])

  // ── Realtime: messages (RLS-scoped to my conversations) + my notifications ──
  useEffect(() => {
    if (!employeeId) return
    const supabase = createClient()
    const channel = supabase
      .channel('comms-widget')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          const convId = String(row.conversation_id ?? '')
          if (!convId || row.parent_id || row.deleted_at) return
          const mine = row.sender_id === employeeId
          const kind = String(row.kind ?? 'text')
          const body = String(row.body ?? '')

          // If this conversation's thread is open in the widget, append it live.
          if (openRef.current && activeIdRef.current === convId) {
            setMessages(prev => prev.some(m => m.id === row.id) ? prev : [...prev, {
              id: String(row.id), conversationId: convId,
              senderId: (row.sender_id as string | null) ?? null,
              senderName: null, senderCqid: null, body, kind,
              createdAt: String(row.created_at), editedAt: null, deletedAt: null,
              parentId: null, metadata: (row.metadata as Record<string, unknown>) ?? {},
              replyCount: 0, reactions: {}, attachments: [], readerIds: [], playedByIds: [],
            }])
            if (!mine) void markRead(convId)
            return
          }
          if (mine) return

          // Otherwise bump that conversation's unread + move it to the top.
          setConvs(prev => {
            const found = prev.find(c => c.id === convId)
            if (!found) { void refreshConvs(); return prev }
            const updated: ChatConversation = {
              ...found, unread: found.unread + 1,
              lastMessage: { body: previewOf(kind, body), senderName: null, senderCqid: null, createdAt: String(row.created_at) },
            }
            return [updated, ...prev.filter(c => c.id !== convId)]
          })
          // Slide-in toast when the panel isn't showing that conversation.
          setToast({
            title: '💬 New message',
            body: previewOf(kind, body).slice(0, 90),
            onClick: () => { setOpen(true); setTab('chat'); void openConversation(convId) },
          })
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `employee_id=eq.${employeeId}` },
        (payload) => {
          const row = payload.new as unknown as NotificationRow
          setNotifs(prev => prev.some(n => n.id === row.id) ? prev : [row, ...prev].slice(0, 20))
          setNotifUnread(n => n + 1)
          setToast({
            title: row.title || '🔔 Notification',
            body: (row.message ?? '').slice(0, 90),
            onClick: () => { setOpen(true); setTab('alerts'); if (row.link) router.push(row.link) },
          })
        })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId])

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(t)
  }, [toast])

  // Scroll thread to bottom when messages change.
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [messages])

  const send = () => {
    const text = draft.trim()
    if (!text || !activeId) return
    setDraft('')
    const tempId = `tmp-${Date.now()}`
    const optimistic: ChatMessage = {
      id: tempId, conversationId: activeId, senderId: employeeId,
      senderName: user.name ?? null, senderCqid: user.cqid, body: text, kind: 'text',
      createdAt: new Date().toISOString(), editedAt: null, deletedAt: null, parentId: null,
      metadata: {}, replyCount: 0, reactions: {}, attachments: [], readerIds: [], playedByIds: [],
    }
    setMessages(prev => [...prev, optimistic])
    startTransition(async () => {
      const res = await sendMessage(activeId, text)
      if (res.ok) setMessages(prev => prev.map(m => m.id === tempId ? res.data : m))
      else setMessages(prev => prev.filter(m => m.id !== tempId))
    })
  }

  const openNotification = (n: NotificationRow) => {
    if (!n.read) {
      setNotifs(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x))
      setNotifUnread(c => Math.max(0, c - 1))
      void markNotificationRead(n.id)
    }
    if (n.link) { setOpen(false); router.push(n.link) }
  }

  const activeConv = convs.find(c => c.id === activeId) ?? null

  return (
    <>
      {/* Slide-in toast (works even when the panel is closed) */}
      {toast && (
        <button
          onClick={() => { toast.onClick(); setToast(null) }}
          className="fixed bottom-24 right-5 z-[60] w-72 rounded-xl border border-border bg-card p-3 text-left shadow-xl animate-in slide-in-from-bottom-2 fade-in"
        >
          <p className="truncate text-sm font-semibold">{toast.title}</p>
          {toast.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{toast.body}</p>}
        </button>
      )}

      {/* Launcher */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Chat & alerts"
        className="fixed bottom-5 right-5 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-transform hover:scale-105"
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
        {!open && totalBadge > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {totalBadge > 99 ? '99+' : totalBadge}
          </span>
        )}
      </button>

      {/* Panel */}
      {open && (
        <div className="fixed bottom-20 right-5 z-50 flex h-[540px] max-h-[calc(100dvh-6rem)] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
          {/* Tabs */}
          <div className="flex items-center border-b border-border">
            <button onClick={() => { setTab('chat'); setActiveId(null) }}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-sm font-medium ${tab === 'chat' ? 'border-b-2 border-foreground text-foreground' : 'text-muted-foreground'}`}>
              <MessageCircle className="h-4 w-4" /> Chat
              {chatUnread > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{chatUnread}</span>}
            </button>
            <button onClick={() => setTab('alerts')}
              className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-sm font-medium ${tab === 'alerts' ? 'border-b-2 border-foreground text-foreground' : 'text-muted-foreground'}`}>
              <Bell className="h-4 w-4" /> Alerts
              {notifUnread > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{notifUnread}</span>}
            </button>
          </div>

          {/* ── Chat tab ── */}
          {tab === 'chat' && !activeId && (
            <div className="flex-1 overflow-y-auto">
              {convs.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No conversations yet.</p>}
              {convs.map(c => (
                <button key={c.id} onClick={() => openConversation(c.id)}
                  className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-2.5 text-left hover:bg-muted/50">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                    {c.type === 'dm' ? convTitle(c).slice(0, 2).toUpperCase()
                      : c.isPrivate ? <Lock className="h-4 w-4" /> : <Hash className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{convTitle(c)}</span>
                      {c.lastMessage && <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel(c.lastMessage.createdAt)}</span>}
                    </span>
                    {c.lastMessage && <span className="block truncate text-xs text-muted-foreground">{c.lastMessage.body}</span>}
                  </span>
                  {c.unread > 0 && <span className="shrink-0 rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{c.unread}</span>}
                </button>
              ))}
            </div>
          )}

          {/* ── Chat thread ── */}
          {tab === 'chat' && activeId && (
            <>
              <div className="flex items-center gap-2 border-b border-border px-2 py-2">
                <button onClick={() => setActiveId(null)} className="rounded p-1 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
                <span className="truncate text-sm font-semibold">{activeConv ? convTitle(activeConv) : 'Conversation'}</span>
                <button onClick={() => { setOpen(false); router.push(`/dashboard/chat?c=${activeId}`) }}
                  className="ml-auto text-[11px] text-muted-foreground hover:text-foreground">Open full ↗</button>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-3">
                {loadingThread && <p className="text-center text-xs text-muted-foreground">Loading…</p>}
                {messages.map(m => {
                  const mine = m.senderId === employeeId
                  return (
                    <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${mine ? 'bg-foreground text-background' : 'bg-muted'}`}>
                        {!mine && <p className="mb-0.5 text-[10px] font-medium opacity-70">{mask(m.senderName, m.senderCqid)}</p>}
                        <p className="whitespace-pre-wrap break-words">{previewOf(m.kind, m.body)}</p>
                        <p className={`mt-0.5 text-[9px] ${mine ? 'text-background/60' : 'text-muted-foreground'}`}>{timeLabel(m.createdAt)}{m.editedAt ? ' · edited' : ''}</p>
                      </div>
                    </div>
                  )
                })}
                <div ref={bottomRef} />
              </div>
              <div className="flex items-end gap-2 border-t border-border p-2">
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                  rows={1} placeholder="Message…"
                  className="max-h-24 flex-1 resize-none rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/30"
                />
                <button onClick={send} disabled={!draft.trim()}
                  className="rounded-lg bg-foreground p-2 text-background disabled:opacity-30" aria-label="Send">
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </>
          )}

          {/* ── Alerts tab ── */}
          {tab === 'alerts' && (
            <div className="flex-1 overflow-y-auto">
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">{notifUnread} unread</span>
                {notifUnread > 0 && (
                  <button onClick={() => { setNotifs(prev => prev.map(n => ({ ...n, read: true }))); setNotifUnread(0); void markAllNotificationsRead() }}
                    className="text-[11px] text-violet-500 hover:underline">Mark all read</button>
                )}
              </div>
              {notifs.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No notifications.</p>}
              {notifs.map(n => (
                <button key={n.id} onClick={() => openNotification(n)}
                  className={`flex w-full items-start gap-2 border-b border-border/50 px-3 py-2.5 text-left hover:bg-muted/50 ${n.read ? '' : 'bg-violet-500/5'}`}>
                  {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-violet-500" />}
                  <span className={`min-w-0 flex-1 ${n.read ? 'pl-4' : ''}`}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{n.title}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel(n.created_at)}</span>
                    </span>
                    {n.message && <span className="block truncate text-xs text-muted-foreground">{n.message}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}
