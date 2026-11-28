import { describe, expect, it } from 'vitest'
import { chatKind, dayBucket, groupChats, KIND_META, sortChats, type ListConversation } from './kinds'

const conv = (id: string, over: Partial<ListConversation> = {}): ListConversation => ({
  id, type: 'channel', category: 'general', posting: 'all', clientId: null, clientName: null,
  unread: 0, pinned: false, urgentUnread: false, isMember: true, lastMessage: null, ...over,
})
const name = (c: ListConversation) => c.id

describe('chatKind', () => {
  it('reads every kind of room', () => {
    expect(chatKind(conv('a', { type: 'dm', category: null }))).toBe('direct')
    expect(chatKind(conv('a', { category: 'self' }))).toBe('notes')
    expect(chatKind(conv('a', { type: 'task', category: 'discussion' }))).toBe('task')
    expect(chatKind(conv('a', { type: 'request', category: 'discussion' }))).toBe('request')
    expect(chatKind(conv('a', { type: 'plan_item', category: 'discussion' }))).toBe('plan')
    expect(chatKind(conv('a', { type: 'project', category: 'discussion' }))).toBe('campaign')
    expect(chatKind(conv('a', { type: 'client', category: 'discussion' }))).toBe('client')
    expect(chatKind(conv('a', { category: 'client' }))).toBe('client')
    expect(chatKind(conv('a', { category: 'department' }))).toBe('department')
    expect(chatKind(conv('a', { posting: 'admins' }))).toBe('announcement')
    expect(chatKind(conv('a'))).toBe('channel')
  })
  it('people are round, rooms square, work threads labelled', () => {
    expect(KIND_META.direct.shape).toBe('round')
    expect(KIND_META.client.shape).toBe('square')
    expect(KIND_META.task.thread).toBe(true)
  })
})

describe('sortChats', () => {
  const list = [
    conv('b', { lastMessage: { createdAt: '2026-11-27T10:00:00Z' } }),
    conv('a', { lastMessage: { createdAt: '2026-11-28T10:00:00Z' } }),
    conv('c', { unread: 3, lastMessage: { createdAt: '2026-11-20T10:00:00Z' } }),
    conv('p', { pinned: true, lastMessage: { createdAt: '2026-10-01T10:00:00Z' } }),
    conv('u', { urgentUnread: true, unread: 1 }),
  ]
  it('urgent, then pinned, lead whatever the sort', () => {
    for (const s of ['recent', 'unread', 'name'] as const) expect(sortChats(list, s, name).slice(0, 2).map(c => c.id)).toEqual(['u', 'p'])
  })
  it('recent activity, unread first, or by name', () => {
    expect(sortChats(list, 'recent', name).map(c => c.id)).toEqual(['u', 'p', 'a', 'b', 'c'])
    expect(sortChats(list, 'unread', name).map(c => c.id)).toEqual(['u', 'p', 'c', 'a', 'b'])
    expect(sortChats(list, 'name', name).map(c => c.id)).toEqual(['u', 'p', 'a', 'b', 'c'])
  })
})

describe('groupChats', () => {
  const now = new Date('2026-11-28T12:00:00')
  const list = [
    conv('pin', { pinned: true }),
    conv('dm', { type: 'dm', category: null, lastMessage: { createdAt: '2026-11-28T09:00:00' } }),
    conv('sea', { category: 'client', clientId: 'c1', clientName: 'Sea Star', lastMessage: { createdAt: '2026-11-27T09:00:00' } }),
    conv('task', { type: 'task', category: 'discussion', clientId: 'c1', clientName: 'Sea Star', lastMessage: { createdAt: '2026-11-24T09:00:00' } }),
    conv('mezza', { type: 'project', category: 'discussion', clientId: 'c2', clientName: 'Mezza', lastMessage: { createdAt: '2026-10-01T09:00:00' } }),
    conv('design', { category: 'department' }),
  ]
  it('keeps one list when not grouped', () => {
    expect(groupChats(list, 'none', now).map(s => s.items.length)).toEqual([6])
  })
  it('by day: pinned, today, yesterday, this week, earlier', () => {
    expect(groupChats(list, 'recent', now).map(s => `${s.label}:${s.items.map(c => c.id).join(',')}`))
      .toEqual(['Pinned:pin', 'Today:dm', 'Yesterday:sea', 'This week:task', 'Earlier:mezza', 'No messages yet:design'])
  })
  it('by type, in a fixed order', () => {
    expect(groupChats(list, 'type', now).map(s => s.label)).toEqual(['Pinned', 'Direct messages', 'Departments', 'Clients', 'Work threads'])
  })
  it('by client: each client with its threads, the team first', () => {
    expect(groupChats(list, 'client', now).map(s => `${s.label}:${s.items.map(c => c.id).join(',')}`))
      .toEqual(['Pinned:pin', 'Team and direct:dm,design', 'Mezza:mezza', 'Sea Star:sea,task'])
  })
  it('day buckets', () => {
    expect(dayBucket(null, now)).toBe('No messages yet')
    expect(dayBucket('2026-11-28T00:30:00', now)).toBe('Today')
    expect(dayBucket('2026-11-22T00:30:00', now)).toBe('This week')
    expect(dayBucket('2026-11-21T00:30:00', now)).toBe('Earlier')
  })
})
