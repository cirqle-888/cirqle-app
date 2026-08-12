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
import { MessageCircle, Bell, X, ArrowLeft, Send, Hash, Lock, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/contexts/permission-context'
import { displayEmployee } from '@/lib/utils/employee-display'
import { installChimeUnlock, playChime } from '@/lib/notifications/chime'
import {
  listConversations, getMessages, sendMessage, markRead,
  type ChatConversation, type ChatMessage,
} from '@/app/(dashboard)/dashboard/chat/actions'
import {
  getMyNotifications, markNotificationRead, markAllNotificationsRead,
  type NotificationRow,
} from '@/app/api/notifications/actions'

type Tab = 'chat' | 'alerts'

/** True inside the Cirqle Desktop (Electron) shell, where the app-wide
 *  DesktopNotifier owns native notifications — the web Notification here
 *  would double-alert. The in-app chime still plays (it IS the desktop
 *  sound: the native banner is silent so audio never depends on OS
 *  notification permission). */
function inDesktopShell(): boolean {
  if (typeof window === 'undefined') return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (window as any).__CIRQLE_DESKTOP__?.notify === 'function'
}

/** True while the user is actively reading conversation `convId` on the full
 *  chat page (it publishes `__cirqleActiveConv`) — no toast/chime for a
 *  message they're literally looking at. */
function isActivelyViewing(convId: string): boolean {
  if (typeof document === 'undefined') return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = (window as any).__cirqleActiveConv as string | null | undefined
  return active === convId && document.visibilityState === 'visible'
}

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

interface ClientGroup {
  clientId: string
  name: string
  /** The client's own channel, when it has one. */
  channel: ChatConversation | null
  /** Its task / request / plan / campaign discussions. */
  threads: ChatConversation[]
  unreadTotal: number
  /** Newest activity across the channel and every thread — for the row preview. */
  lastAt: string | null
}

/**
 * Same shape as the /dashboard/chat sidebar: channels and departments, then one
 * row per CLIENT holding that client's discussions, then DMs. The widget used
 * to render one flat recency-ordered pile, so a plan thread, a request thread
 * and a DM sat side by side with no clue which client they belonged to.
 */
function buildNav(convs: ChatConversation[]) {
  const isChannelish = (c: ChatConversation) => c.type === 'channel' || c.type === 'group'
  const clientChannels = convs.filter(c => isChannelish(c) && c.category === 'client')
  const discussions = convs.filter(c => c.category === 'discussion')

  const groups = new Map<string, ClientGroup>()
  const groupFor = (clientId: string, name: string): ClientGroup => {
    let g = groups.get(clientId)
    if (!g) { g = { clientId, name, channel: null, threads: [], unreadTotal: 0, lastAt: null }; groups.set(clientId, g) }
    if (name && g.name === 'Client') g.name = name
    return g
  }
  const touch = (g: ClientGroup, c: ChatConversation) => {
    g.unreadTotal += c.unread
    const at = c.lastMessage?.createdAt ?? null
    if (at && (!g.lastAt || at > g.lastAt)) g.lastAt = at
  }

  for (const ch of clientChannels) {
    if (!ch.clientId) continue
    const g = groupFor(ch.clientId, ch.clientName ?? ch.name ?? 'Client')
    g.channel = ch
    touch(g, ch)
  }
  for (const d of discussions) {
    // A room of type 'client' IS the client's channel, not a thread under it.
    if (d.type === 'client') {
      if (!d.clientId) continue
      const g = groupFor(d.clientId, d.clientName ?? d.name ?? 'Client')
      g.channel ??= d
      touch(g, d)
      continue
    }
    if (!d.clientId) continue
    const g = groupFor(d.clientId, d.clientName ?? 'Client')
    g.threads.push(d)
    touch(g, d)
  }

  const grouped = new Set(
    [...groups.values()].flatMap(g => [g.channel?.id, ...g.threads.map(t => t.id)]).filter(Boolean) as string[],
  )
  return {
    channels: convs.filter(c => isChannelish(c) && (c.category ?? 'general') === 'general'),
    departments: convs.filter(c => isChannelish(c) && c.category === 'department'),
    clientGroups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
    // A client channel with no clientId can't be grouped — keep it reachable.
    looseClientChannels: clientChannels.filter(c => !c.clientId),
    // A discussion with no client at all would otherwise be unreachable.
    otherDiscussions: discussions.filter(c => !grouped.has(c.id)),
    dms: convs.filter(c => c.type === 'dm'),
  }
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
      {children}
    </p>
  )
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
  /** Drilled into one client's rooms. Survives opening a thread, so the thread's
   *  back button returns to the client instead of the top of the list. */
  const [clientId, setClientId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [loadingThread, setLoadingThread] = useState(false)
  const [, startTransition] = useTransition()
  const [toast, setToast] = useState<{ title: string; body: string; onClick: () => void } | null>(null)

  const activeIdRef = useRef<string | null>(null)
  const openRef = useRef(false)
  const convsRef = useRef<ChatConversation[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  useEffect(() => { openRef.current = open }, [open])
  useEffect(() => { convsRef.current = convs }, [convs])

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
    // Anchor the back button: a room that belongs to a client returns to that
    // client, anything else returns to the top of the list. This also keeps a
    // toast-opened thread from backing into an unrelated client.
    const conv = convsRef.current.find(c => c.id === convId)
    setClientId(conv?.clientId ?? null)
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

  // Unlock the chime's AudioContext on the first user gesture, and use the
  // same gesture to ask for system-notification permission (a gesture-tied
  // prompt is far more likely to be shown/granted than one on page load).
  useEffect(() => {
    const cleanupChime = installChimeUnlock()
    const askOnce = () => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default' && !inDesktopShell()) {
        void Notification.requestPermission().catch(() => {})
      }
      window.removeEventListener('pointerdown', askOnce)
    }
    window.addEventListener('pointerdown', askOnce, { passive: true })
    return () => { cleanupChime(); window.removeEventListener('pointerdown', askOnce) }
  }, [])

  // System notification for a message/alert the user isn't looking at —
  // browser only (desktop has native ones), and only when this tab isn't the
  // thing they're focused on. Tag dedupes against the Web Push notification
  // for the same conversation/alert, so a device with push enabled shows one
  // banner, not two.
  const systemNotify = useCallback((title: string, body: string, tag: string, onClick: () => void) => {
    if (inDesktopShell()) return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (document.visibilityState === 'visible' && document.hasFocus()) return
    try {
      const n = new Notification(title, { body, tag })
      n.onclick = () => { window.focus(); onClick(); n.close() }
    } catch { /* unsupported */ }
  }, [])

  // Desktop toolbar bell click → open this widget on the Alerts tab, no
  // matter which page is currently showing.
  useEffect(() => {
    const onOpenNotifications = () => { setOpen(true); setTab('alerts') }
    // Header chat button → toggle this widget on the Chat tab. Same surface,
    // just a second way in for people who never look at the corner launcher.
    const onToggleChat = () => {
      setTab('chat')
      setOpen(o => !o)
    }
    window.addEventListener('cirqle:openNotifications', onOpenNotifications)
    window.addEventListener('cirqle:toggleChat', onToggleChat)
    return () => {
      window.removeEventListener('cirqle:openNotifications', onOpenNotifications)
      window.removeEventListener('cirqle:toggleChat', onToggleChat)
    }
  }, [])

  // ── Realtime: messages (RLS-scoped to my conversations) + my notifications ──
  useEffect(() => {
    if (!employeeId) return
    const supabase = createClient()
    // Unique per mount — a static topic name gets reused (returns the same,
    // already-subscribed channel) if the previous mount's async removeChannel
    // hasn't finished yet, which throws under React Strict Mode's dev
    // double-effect remount.
    const channel = supabase
      .channel(`comms-widget-${crypto.randomUUID()}`)
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
          // Reading this conversation on the full chat page right now → the
          // unread bump above is enough; no toast/chime/banner in their face.
          if (isActivelyViewing(convId)) return
          const preview = previewOf(kind, body).slice(0, 90)
          playChime()
          systemNotify('💬 New message', preview, `msg:${convId}`,
            () => { setOpen(true); setTab('chat'); void openConversation(convId) })
          // Slide-in toast when the panel isn't showing that conversation.
          setToast({
            title: '💬 New message',
            body: preview,
            onClick: () => { setOpen(true); setTab('chat'); void openConversation(convId) },
          })
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `employee_id=eq.${employeeId}` },
        (payload) => {
          const row = payload.new as unknown as NotificationRow
          setNotifs(prev => prev.some(n => n.id === row.id) ? prev : [row, ...prev].slice(0, 20))
          setNotifUnread(n => n + 1)
          playChime()
          systemNotify(row.title || '🔔 Notification', (row.message ?? '').slice(0, 120),
            `notif:${(row as { source_key?: string | null }).source_key ?? row.id}`,
            () => { setOpen(true); setTab('alerts'); if (row.link) router.push(row.link) })
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

  // Relay the combined unread count to the Cirqle Desktop shell so it can show
  // a native top-bar + dock badge (no-op in a normal browser).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b = (window as any).__CIRQLE_DESKTOP__
    if (b && typeof b.setBadge === 'function') b.setBadge(totalBadge)
  }, [totalBadge])

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
  const nav = useMemo(() => buildNav(convs), [convs])
  const activeClient = clientId ? nav.clientGroups.find(g => g.clientId === clientId) ?? null : null

  /** One list row — used for channels, client threads and DMs alike. */
  const convRow = (c: ChatConversation, indented = false) => (
    <button key={c.id} onClick={() => openConversation(c.id)}
      className={`flex w-full items-center gap-3 border-b border-border/50 py-2.5 pr-3 text-left hover:bg-muted/50 ${indented ? 'pl-6' : 'pl-3'}`}>
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
  )

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
            <button onClick={() => { setTab('chat'); setActiveId(null); setClientId(null) }}
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

          {/* ── Chat: top level — channels, clients, DMs ── */}
          {tab === 'chat' && !activeId && !activeClient && (
            <div className="flex-1 overflow-y-auto pb-2">
              {convs.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No conversations yet.</p>}

              {nav.channels.length > 0 && <SectionLabel>Channels</SectionLabel>}
              {nav.channels.map(c => convRow(c))}

              {nav.departments.length > 0 && <SectionLabel>Departments</SectionLabel>}
              {nav.departments.map(c => convRow(c))}

              {(nav.clientGroups.length > 0 || nav.looseClientChannels.length > 0) && <SectionLabel>Clients</SectionLabel>}
              {nav.clientGroups.map(g => {
                const rooms = g.threads.length + (g.channel ? 1 : 0)
                return (
                  <button key={g.clientId} onClick={() => setClientId(g.clientId)}
                    className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-2.5 text-left hover:bg-muted/50">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Hash className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{g.name}</span>
                        {g.lastAt && <span className="shrink-0 text-[10px] text-muted-foreground">{timeLabel(g.lastAt)}</span>}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {rooms} {rooms === 1 ? 'conversation' : 'conversations'}
                      </span>
                    </span>
                    {g.unreadTotal > 0 && <span className="shrink-0 rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">{g.unreadTotal}</span>}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
                  </button>
                )
              })}
              {nav.looseClientChannels.map(c => convRow(c))}

              {nav.otherDiscussions.length > 0 && <SectionLabel>Other discussions</SectionLabel>}
              {nav.otherDiscussions.map(c => convRow(c))}

              {nav.dms.length > 0 && <SectionLabel>Direct messages</SectionLabel>}
              {nav.dms.map(c => convRow(c))}
            </div>
          )}

          {/* ── Chat: one client's rooms ── */}
          {tab === 'chat' && !activeId && activeClient && (
            <>
              <div className="flex items-center gap-2 border-b border-border px-2 py-2">
                <button onClick={() => setClientId(null)} aria-label="Back to conversations"
                  className="rounded p-1 text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /></button>
                <span className="truncate text-sm font-semibold">{activeClient.name}</span>
              </div>
              <div className="flex-1 overflow-y-auto pb-2">
                {activeClient.channel && (
                  <>
                    <SectionLabel>Channel</SectionLabel>
                    {convRow(activeClient.channel)}
                  </>
                )}
                {activeClient.threads.length > 0 && (
                  <>
                    <SectionLabel>Discussions</SectionLabel>
                    {activeClient.threads.map(c => convRow(c, true))}
                  </>
                )}
                {!activeClient.channel && activeClient.threads.length === 0 && (
                  <p className="p-6 text-center text-sm text-muted-foreground">Nothing here yet.</p>
                )}
              </div>
            </>
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
