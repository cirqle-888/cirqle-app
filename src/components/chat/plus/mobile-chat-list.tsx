'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { BellOff, Check, Pin, SlidersHorizontal } from 'lucide-react'
import type { ChatConversation } from '@/app/(dashboard)/dashboard/chat/actions'
import {
  chatKind, groupChats, GROUPING_LABEL, KIND_META, SORT_LABEL, sortChats,
  type ChatGrouping, type ChatSort,
} from '@/lib/chat/kinds'
import { KindTag, KindTile } from './kind-tile'
import { useMessageGestures } from './use-press'

type Filter = 'all' | 'unread' | 'direct' | 'team' | 'clients' | 'work'
const FILTERS: [Filter, string][] = [
  ['all', 'All'], ['unread', 'Unread'], ['direct', 'Direct'], ['team', 'Team'], ['clients', 'Clients'], ['work', 'Work'],
]

/** Remembered on this device only — a convenience, never shared state. */
const VIEW_KEY = 'cirqle_chat_list_view'
type View = { sort: ChatSort; grouping: ChatGrouping }
const DEFAULT_VIEW: View = { sort: 'recent', grouping: 'none' }

const VIEW_EVENT = 'cirqle:chat-list-view'

function parseView(raw: string): View {
  try {
    const v = JSON.parse(raw || 'null') as Partial<View> | null
    return {
      sort: v?.sort && v.sort in SORT_LABEL ? v.sort : DEFAULT_VIEW.sort,
      grouping: v?.grouping && v.grouping in GROUPING_LABEL ? v.grouping : DEFAULT_VIEW.grouping,
    }
  } catch { return DEFAULT_VIEW }
}
// The saved view as a string snapshot: '' on the server and when storage is
// unavailable, so the first paint always matches and nothing throws.
const readRaw = () => { try { return localStorage.getItem(VIEW_KEY) ?? '' } catch { return '' } }
const subscribeView = (onChange: () => void) => {
  window.addEventListener('storage', onChange)
  window.addEventListener(VIEW_EVENT, onChange)
  return () => { window.removeEventListener('storage', onChange); window.removeEventListener(VIEW_EVENT, onChange) }
}

function when(iso: string): string {
  const d = new Date(iso), now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return d.toLocaleDateString('en-IN', { weekday: 'short' })
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

/**
 * The phone's chat list: newest first by default, with filters on top and a
 * View menu to sort (recent, unread first, A–Z) and group (by day, type or
 * client). Each row shows what kind of chat it is by shape and a quiet word.
 */
export function MobileChatList({ conversations, activeId, meId, nameOf, showName, onOpen, onMenu }: {
  conversations: ChatConversation[]
  activeId: string | null
  meId: string
  nameOf: (c: ChatConversation) => string
  showName: (name?: string | null, cqid?: string | null) => string
  /** Opens a chat I am in; joins one I am not. */
  onOpen: (c: ChatConversation) => void
  onMenu: (c: ChatConversation, point: { x: number; y: number }) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const rawView = useSyncExternalStore(subscribeView, readRaw, () => '')
  const view = useMemo(() => parseView(rawView), [rawView])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])
  const choose = (next: Partial<View>) => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...view, ...next })) } catch { /* private window: not remembered */ }
    window.dispatchEvent(new Event(VIEW_EVENT))
  }

  const unreadCount = useMemo(() => conversations.filter(c => c.isMember && c.unread > 0).length, [conversations])

  const sections = useMemo(() => {
    const list = conversations.filter(c => {
      const k = chatKind(c)
      if (filter === 'unread') return c.isMember && c.unread > 0
      if (filter === 'direct') return k === 'direct' || k === 'notes'
      if (filter === 'team') return ['channel', 'announcement', 'department', 'group'].includes(k)
      if (filter === 'clients') return k === 'client' || !!c.clientId
      if (filter === 'work') return KIND_META[k].thread
      return true
    })
    return groupChats(sortChats(list, view.sort, nameOf), view.grouping, new Date())
  }, [conversations, filter, view, nameOf])
  const empty = sections.every(s => s.items.length === 0)
  const custom = view.sort !== DEFAULT_VIEW.sort || view.grouping !== DEFAULT_VIEW.grouping

  return (
    <div>
      <div className="flex items-center gap-2 px-3 pb-2 pt-1">
        <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {FILTERS.map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)} aria-pressed={filter === key}
              className={`shrink-0 rounded-full border px-3 py-1 text-[13px] transition-colors ${filter === key
                ? 'border-foreground bg-foreground font-medium text-background'
                : 'border-border text-muted-foreground'}`}>
              {label}{key === 'unread' && unreadCount > 0 ? ` · ${unreadCount}` : ''}
            </button>
          ))}
        </div>
        <div ref={menuRef} className="relative shrink-0">
          <button onClick={() => setMenuOpen(o => !o)} aria-label="Sort and group" aria-expanded={menuOpen}
            className={`relative flex h-8 w-8 items-center justify-center rounded-full border ${custom ? 'border-foreground text-foreground' : 'border-border text-muted-foreground'}`}>
            <SlidersHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-10 z-40 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
              <MenuGroup title="Sort by">
                {(Object.keys(SORT_LABEL) as ChatSort[]).map(s => (
                  <MenuItem key={s} label={SORT_LABEL[s]} on={view.sort === s} onPick={() => choose({ sort: s })} />
                ))}
              </MenuGroup>
              <div className="my-1 h-px bg-border" />
              <MenuGroup title="Group">
                {(Object.keys(GROUPING_LABEL) as ChatGrouping[]).map(g => (
                  <MenuItem key={g} label={GROUPING_LABEL[g]} on={view.grouping === g} onPick={() => choose({ grouping: g })} />
                ))}
              </MenuGroup>
            </div>
          )}
        </div>
      </div>

      {sections.map(s => s.items.length > 0 && (
        <div key={s.key}>
          {s.label && (
            <div className="sticky top-0 z-10 flex items-baseline justify-between bg-background/95 px-4 pb-1 pt-3 backdrop-blur">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{s.label}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground/70">{s.items.length}</span>
            </div>
          )}
          {s.items.map(c => (
            <Row key={c.id} conv={c} active={c.id === activeId} meId={meId} name={nameOf(c)} showName={showName}
              hideClient={view.grouping === 'client'} onOpen={onOpen} onMenu={onMenu} />
          ))}
        </div>
      ))}
      {empty && (
        <p className="px-6 py-10 text-center text-sm text-muted-foreground">
          {filter === 'unread' ? 'You are all caught up.' : filter === 'all' ? 'No chats yet. Tap + to start one.' : 'Nothing here yet.'}
        </p>
      )}
    </div>
  )
}

function MenuGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

function MenuItem({ label, on, onPick }: { label: string; on: boolean; onPick: () => void }) {
  return (
    <button role="menuitemradio" aria-checked={on} onClick={onPick}
      className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted">
      {label}{on && <Check className="h-4 w-4" />}
    </button>
  )
}

function Row({ conv, active, meId, name, showName, hideClient, onOpen, onMenu }: {
  conv: ChatConversation; active: boolean; meId: string; name: string
  showName: (name?: string | null, cqid?: string | null) => string
  /** Grouped by client already — do not repeat the client on each row. */
  hideClient: boolean
  onOpen: (c: ChatConversation) => void
  onMenu: (c: ChatConversation, point: { x: number; y: number }) => void
}) {
  const gestures = useMessageGestures({ onHold: point => onMenu(conv, point) })
  const kind = chatKind(conv)
  const meta = KIND_META[kind]
  const partnerId = kind === 'direct' ? conv.members.find(m => m.employeeId !== meId)?.employeeId ?? null : null
  const muted = conv.notifyLevel === 'none'
  const last = conv.lastMessage
  const who = last && kind !== 'direct' && (last.senderCqid || last.senderName) ? `${showName(last.senderName, last.senderCqid)}: ` : ''
  const unread = conv.unread > 0
  const where = meta.thread && conv.clientName && !hideClient ? conv.clientName : null
  return (
    <button
      {...gestures.handlers}
      onContextMenu={e => { e.preventDefault(); if (!gestures.wasHeld()) onMenu(conv, { x: e.clientX, y: e.clientY }) }}
      onClick={() => { if (!gestures.wasHeld()) onOpen(conv) }}
      className={`relative flex w-full items-center gap-3 px-3 py-2.5 text-left [-webkit-touch-callout:none] active:bg-muted ${active ? 'bg-muted' : ''}`}>
      {unread && !muted && <span aria-hidden className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r bg-primary" />}
      <KindTile kind={kind} name={name} isPrivate={conv.isPrivate} partnerId={partnerId} />
      <span className="min-w-0 flex-1 border-b border-border/50 pb-2.5">
        <span className="flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[15px] ${unread ? 'font-semibold' : 'font-medium'}`}>{name}</span>
          {conv.urgentUnread && <span className="shrink-0 rounded bg-red-500 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-white">Urgent</span>}
          {last && <span className={`shrink-0 text-[11px] tabular-nums ${unread && !muted ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{when(last.createdAt)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          {kind !== 'direct' && <KindTag kind={kind} />}
          {where && <span className="max-w-[40%] shrink-0 truncate text-[12px] text-muted-foreground">{where} ·</span>}
          <span className={`min-w-0 flex-1 truncate text-[13px] ${unread ? 'text-foreground/80' : 'text-muted-foreground'}`}>
            {!conv.isMember ? 'Tap to join' : last ? `${who}${last.body}` : conv.topic || 'No messages yet'}
          </span>
          {conv.pinned && <Pin className="h-3.5 w-3.5 shrink-0 fill-current text-muted-foreground" aria-label="Pinned" />}
          {muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />}
          {unread && (
            <span className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ${muted ? 'bg-muted-foreground/40 text-background' : 'bg-primary text-primary-foreground'}`}>
              {conv.unread > 99 ? '99+' : conv.unread}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
