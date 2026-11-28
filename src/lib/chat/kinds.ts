/**
 * What kind of chat a conversation is, and how the chat list sorts and groups
 * them (pure — shared by the phone list and the desktop sidebar).
 *
 * The list tells kinds apart by SHAPE and a quiet word, not by colour:
 * people are round, rooms are square, and a work thread carries a small
 * label ("Task", "Request"…). One accent colour is left for what needs you.
 */

export type ChatKind =
  | 'direct' | 'notes' | 'group'
  | 'channel' | 'announcement' | 'department'
  | 'client'
  | 'task' | 'request' | 'plan' | 'campaign'

/** The fields of a conversation the list needs. */
export interface ListConversation {
  id: string
  type: string
  category: string | null
  posting?: 'all' | 'admins'
  clientId: string | null
  clientName: string | null
  unread: number
  pinned: boolean
  urgentUnread: boolean
  isMember: boolean
  lastMessage: { createdAt: string } | null
}

export interface KindMeta {
  /** A word for one, shown on the row: "Task", "Client"… */
  label: string
  /** Heading when the list is grouped by type. */
  group: string
  /** People are round; rooms and threads are square. */
  shape: 'round' | 'square'
  /** Threads about one piece of work — shown smaller, with their label. */
  thread: boolean
}

export const KIND_META: Record<ChatKind, KindMeta> = {
  direct:       { label: 'Direct',       group: 'Direct messages', shape: 'round',  thread: false },
  notes:        { label: 'Notes',        group: 'Direct messages', shape: 'square', thread: false },
  group:        { label: 'Group',        group: 'Team',            shape: 'square', thread: false },
  channel:      { label: 'Channel',      group: 'Team',            shape: 'square', thread: false },
  announcement: { label: 'Announcement', group: 'Team',            shape: 'square', thread: false },
  department:   { label: 'Department',   group: 'Departments',     shape: 'square', thread: false },
  client:       { label: 'Client',       group: 'Clients',         shape: 'square', thread: false },
  task:         { label: 'Task',         group: 'Work threads',    shape: 'square', thread: true },
  request:      { label: 'Request',      group: 'Work threads',    shape: 'square', thread: true },
  plan:         { label: 'Plan',         group: 'Work threads',    shape: 'square', thread: true },
  campaign:     { label: 'Campaign',     group: 'Work threads',    shape: 'square', thread: true },
}

/** Order of the type groups, top to bottom. */
export const GROUP_ORDER = ['Pinned', 'Direct messages', 'Team', 'Departments', 'Clients', 'Work threads'] as const

export function chatKind(c: Pick<ListConversation, 'type' | 'category' | 'posting'>): ChatKind {
  if (c.type === 'dm') return 'direct'
  if (c.category === 'self') return 'notes'
  if (c.type === 'task') return 'task'
  if (c.type === 'request') return 'request'
  if (c.type === 'plan' || c.type === 'plan_item') return 'plan'
  if (c.type === 'project') return 'campaign'
  if (c.type === 'client' || c.category === 'client') return 'client'
  if (c.category === 'department') return 'department'
  if (c.posting === 'admins') return 'announcement'
  if (c.type === 'group') return 'group'
  return 'channel'
}

export type ChatSort = 'recent' | 'unread' | 'name'
export type ChatGrouping = 'none' | 'recent' | 'type' | 'client'

export const SORT_LABEL: Record<ChatSort, string> = { recent: 'Recent activity', unread: 'Unread first', name: 'Name (A–Z)' }
export const GROUPING_LABEL: Record<ChatGrouping, string> = { none: 'No groups', recent: 'By day', type: 'By type', client: 'By client' }

const at = (c: ListConversation) => c.lastMessage?.createdAt ?? ''

/**
 * Sort a list. Whatever the choice, an unread urgent message leads, then
 * pinned chats, then chats I am in — the same promise the list always made.
 */
export function sortChats<T extends ListConversation>(list: readonly T[], sort: ChatSort, nameOf: (c: T) => string): T[] {
  return [...list].sort((a, b) =>
    Number(b.urgentUnread) - Number(a.urgentUnread)
    || Number(b.pinned) - Number(a.pinned)
    || Number(b.isMember) - Number(a.isMember)
    || (sort === 'unread' ? Number(b.unread > 0) - Number(a.unread > 0) : 0)
    || (sort === 'name' ? nameOf(a).localeCompare(nameOf(b)) : at(b).localeCompare(at(a)))
    || nameOf(a).localeCompare(nameOf(b)))
}

export interface ChatSection<T> { key: string; label: string; items: T[] }

/** "Today", "Yesterday", "This week", "Earlier", or "No messages yet". */
export function dayBucket(iso: string | null | undefined, now: Date): string {
  if (!iso) return 'No messages yet'
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(now) - day(new Date(iso))) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return 'This week'
  return 'Earlier'
}
const DAY_ORDER = ['Today', 'Yesterday', 'This week', 'Earlier', 'No messages yet']

/**
 * Split an already-sorted list into sections. Pinned chats always sit in their
 * own section on top (except with no grouping, where they simply lead).
 */
export function groupChats<T extends ListConversation>(sorted: readonly T[], grouping: ChatGrouping, now: Date): ChatSection<T>[] {
  if (grouping === 'none') return [{ key: 'all', label: '', items: [...sorted] }]
  const pinned = sorted.filter(c => c.pinned)
  const rest = sorted.filter(c => !c.pinned)
  const sections = new Map<string, ChatSection<T>>()
  const add = (key: string, label: string, c: T) => {
    let s = sections.get(key)
    if (!s) { s = { key, label, items: [] }; sections.set(key, s) }
    s.items.push(c)
  }
  for (const c of rest) {
    if (grouping === 'recent') {
      const b = dayBucket(c.lastMessage?.createdAt, now)
      add(b, b, c)
    } else if (grouping === 'type') {
      const g = KIND_META[chatKind(c)].group
      add(g, g, c)
    } else {
      // By client: a client's channel and its work threads together; the rest is the team's.
      if (c.clientId) add(`client:${c.clientId}`, c.clientName ?? 'Client', c)
      else add('team', 'Team and direct', c)
    }
  }
  const rank = (s: ChatSection<T>): [number, string] => {
    if (grouping === 'recent') return [DAY_ORDER.indexOf(s.key), '']
    if (grouping === 'type') return [GROUP_ORDER.indexOf(s.key as typeof GROUP_ORDER[number]), '']
    return s.key === 'team' ? [0, ''] : [1, s.label]
  }
  const ordered = [...sections.values()].sort((a, b) => {
    const [ra, la] = rank(a), [rb, lb] = rank(b)
    return ra - rb || la.localeCompare(lb)
  })
  return pinned.length ? [{ key: 'pinned', label: 'Pinned', items: pinned }, ...ordered] : ordered
}
