'use client'

import { useMemo, useState } from 'react'
import { BellOff, Bookmark, CalendarDays, CheckSquare, Hash, Inbox, Lock, Megaphone, Pin } from 'lucide-react'
import { EmployeePresenceDot } from '@/components/ui/presence-dot'
import type { ChatConversation } from '@/app/(dashboard)/dashboard/chat/actions'
import { useMessageGestures } from './use-press'

type Filter = 'all' | 'unread' | 'direct' | 'groups' | 'clients'
const FILTERS: [Filter, string][] = [['all', 'All'], ['unread', 'Unread'], ['direct', 'Direct'], ['groups', 'Groups'], ['clients', 'Clients']]

const isClientSide = (c: ChatConversation) => c.category === 'client' || c.category === 'discussion'

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
 * The phone's chat list: one list, newest first, the way WhatsApp shows it —
 * picture, name, the last message, the time and a count of what is unread —
 * with a row of filters on top. The grouped sidebar stays for wide screens.
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
  const counts = useMemo(() => ({
    unread: conversations.filter(c => c.isMember && c.unread > 0).length,
  }), [conversations])

  const rows = useMemo(() => {
    const list = conversations.filter(c => {
      if (filter === 'unread') return c.isMember && c.unread > 0
      if (filter === 'direct') return c.type === 'dm' || c.category === 'self'
      if (filter === 'groups') return c.type !== 'dm' && c.category !== 'self' && !isClientSide(c)
      if (filter === 'clients') return isClientSide(c)
      return true
    })
    const at = (c: ChatConversation) => c.lastMessage?.createdAt ?? ''
    return [...list].sort((a, b) =>
      Number(b.pinned) - Number(a.pinned) || Number(b.isMember) - Number(a.isMember) || at(b).localeCompare(at(a)))
  }, [conversations, filter])

  return (
    <div>
      <div className="flex gap-2 overflow-x-auto px-3 pb-2 pt-1 [scrollbar-width:none]">
        {FILTERS.map(([key, label]) => (
          <button key={key} onClick={() => setFilter(key)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm transition-colors ${filter === key ? 'bg-violet-500/20 font-medium text-foreground' : 'bg-muted/60 text-muted-foreground'}`}>
            {label}{key === 'unread' && counts.unread > 0 ? ` ${counts.unread}` : ''}
          </button>
        ))}
      </div>
      {rows.map(c => (
        <Row key={c.id} conv={c} active={c.id === activeId} meId={meId} name={nameOf(c)} showName={showName} onOpen={onOpen} onMenu={onMenu} />
      ))}
      {rows.length === 0 && (
        <p className="px-6 py-10 text-center text-sm text-muted-foreground">
          {filter === 'unread' ? 'You are all caught up.' : filter === 'all' ? 'No chats yet. Tap + to start one.' : 'Nothing here yet.'}
        </p>
      )}
    </div>
  )
}

const ENTITY_ICON: Record<string, typeof Hash> = { task: CheckSquare, request: Inbox, plan: CalendarDays, plan_item: CalendarDays, project: Megaphone }

function Row({ conv, active, meId, name, showName, onOpen, onMenu }: {
  conv: ChatConversation; active: boolean; meId: string; name: string
  showName: (name?: string | null, cqid?: string | null) => string
  onOpen: (c: ChatConversation) => void
  onMenu: (c: ChatConversation, point: { x: number; y: number }) => void
}) {
  const gestures = useMessageGestures({ onHold: point => onMenu(conv, point) })
  const partnerId = conv.type === 'dm' ? conv.members.find(m => m.employeeId !== meId)?.employeeId ?? null : null
  const muted = conv.notifyLevel === 'none'
  const Icon = conv.category === 'self' ? Bookmark : conv.posting === 'admins' ? Megaphone : ENTITY_ICON[conv.type] ?? (conv.isPrivate ? Lock : Hash)
  const last = conv.lastMessage
  const who = last && conv.type !== 'dm' && (last.senderCqid || last.senderName) ? `${showName(last.senderName, last.senderCqid)}: ` : ''
  return (
    <button
      {...gestures.handlers}
      onContextMenu={e => { e.preventDefault(); if (!gestures.wasHeld()) onMenu(conv, { x: e.clientX, y: e.clientY }) }}
      onClick={() => { if (!gestures.wasHeld()) onOpen(conv) }}
      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left [-webkit-touch-callout:none] active:bg-muted ${active ? 'bg-muted' : ''}`}>
      <span className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${conv.type === 'dm' ? 'bg-violet-500/20 text-violet-300' : 'bg-muted text-muted-foreground'}`}>
        {conv.type === 'dm' ? name.slice(0, 2).toUpperCase() : <Icon className="h-5 w-5" />}
        {partnerId && <EmployeePresenceDot employeeId={partnerId} size="sm" className="absolute bottom-0 right-0" />}
      </span>
      <span className="min-w-0 flex-1 border-b border-border/60 pb-2.5">
        <span className="flex items-baseline gap-2">
          <span className={`min-w-0 flex-1 truncate text-[15px] ${conv.unread > 0 ? 'font-semibold' : 'font-medium'}`}>{name}</span>
          {last && <span className={`shrink-0 text-[11px] ${conv.unread > 0 && !muted ? 'font-medium text-violet-400' : 'text-muted-foreground'}`}>{when(last.createdAt)}</span>}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            {!conv.isMember ? 'Tap to join' : last ? `${who}${last.body}` : conv.topic || 'No messages yet'}
          </span>
          {conv.pinned && <Pin className="h-3.5 w-3.5 shrink-0 fill-current text-muted-foreground" aria-label="Pinned" />}
          {muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />}
          {conv.unread > 0 && (
            <span className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold text-white ${muted ? 'bg-muted-foreground/50' : 'bg-violet-500'}`}>
              {conv.unread > 99 ? '99+' : conv.unread}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
