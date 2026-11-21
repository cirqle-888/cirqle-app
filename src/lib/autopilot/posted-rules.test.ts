import { describe, it, expect } from 'vitest'
import { actionFor, liveKind, matchPosted, notSeenLive, plannedKind, type LivePost, type PlannedPost } from './posted-rules'

const plan = (over: Partial<PlannedPost>): PlannedPost => ({
  requestId: 'r', ref: 'REQ-0001', clientId: 'sea', date: '2026-11-16', contentType: 'post', closed: false, ...over,
})
const live = (over: Partial<LivePost>): LivePost => ({
  id: 'm', clientId: 'sea', day: '2026-11-16', kind: 'feed', permalink: 'https://instagram.com/p/x', ...over,
})

describe('kinds', () => {
  it('maps planned content types to what goes live', () => {
    expect(plannedKind('story')).toBe('story')
    expect(plannedKind('reel')).toBe('reel')
    expect(plannedKind('poster')).toBe('feed')
    expect(plannedKind('carousel')).toBe('feed')
    expect(plannedKind(null)).toBe('feed')
    expect(plannedKind('blog')).toBeNull()
  })
  it('reads Meta media rows', () => {
    expect(liveKind({ is_story: true })).toBe('story')
    expect(liveKind({ media_product_type: 'REELS' })).toBe('reel')
    expect(liveKind({ media_product_type: 'FEED' })).toBe('feed')
    expect(liveKind({ media_product_type: null })).toBe('feed')
  })
})

describe('matching live posts to planned posts', () => {
  it('matches a post live on its day or up to three days late', () => {
    expect(matchPosted([plan({})], [live({ day: '2026-11-19' })]).map(m => m.ref)).toEqual(['REQ-0001'])
    expect(matchPosted([plan({})], [live({ day: '2026-11-20' })])).toEqual([])
    expect(matchPosted([plan({})], [live({ day: '2026-11-15' })]).length).toBe(1)
    expect(matchPosted([plan({})], [live({ day: '2026-11-14' })])).toEqual([])
  })
  it('never matches another client or the wrong kind', () => {
    expect(matchPosted([plan({})], [live({ clientId: 'other' })])).toEqual([])
    expect(matchPosted([plan({ contentType: 'story' })], [live({ kind: 'feed' })])).toEqual([])
    expect(matchPosted([plan({})], [live({ kind: 'story' })])).toEqual([])
  })
  it('lets a planned reel use a feed video, but prefers a real reel', () => {
    expect(matchPosted([plan({ contentType: 'reel' })], [live({ kind: 'feed' })]).length).toBe(1)
    const m = matchPosted([plan({ contentType: 'reel' })], [live({ id: 'feed', kind: 'feed' }), live({ id: 'reel', kind: 'reel', day: '2026-11-17' })])
    expect(m[0].post.id).toBe('reel')
  })
  it('uses each live post once, closest date first', () => {
    const planned = [plan({ requestId: 'a', ref: 'REQ-0011', date: '2026-11-11' }), plan({ requestId: 'b', ref: 'REQ-0012', date: '2026-11-12' })]
    const one = matchPosted(planned, [live({ id: 'x', day: '2026-11-12' })])
    expect(one.map(m => m.ref)).toEqual(['REQ-0011'])
    const two = matchPosted(planned, [live({ id: 'x', day: '2026-11-11' }), live({ id: 'y', day: '2026-11-12' })])
    expect(two.map(m => [m.ref, m.post.id])).toEqual([['REQ-0011', 'x'], ['REQ-0012', 'y']])
  })
  it('lets a closed request keep its own post without returning it', () => {
    const planned = [plan({ requestId: 'done', ref: 'REQ-0056', date: '2026-11-15', closed: true }), plan({ requestId: 'open', ref: 'REQ-0057', date: '2026-11-16' })]
    expect(matchPosted(planned, [live({ day: '2026-11-15' })])).toEqual([])
  })
})

describe('past date with nothing live', () => {
  it('lists open posts of connected clients once the window is over', () => {
    const planned = [
      plan({ requestId: 'a', ref: 'REQ-0045', date: '2026-10-03' }),
      plan({ requestId: 'b', ref: 'REQ-0109', date: '2026-11-19' }),
      plan({ requestId: 'c', ref: 'REQ-0058', date: '2026-10-18', closed: true }),
      plan({ requestId: 'd', ref: 'REQ-0070', date: '2026-10-10', clientId: 'not-connected' }),
      plan({ requestId: 'e', ref: 'REQ-0071', date: '2026-10-10' }),
    ]
    const r = notSeenLive(planned, new Set(['e']), new Set(['sea']), '2026-11-21')
    expect(r.map(p => p.ref)).toEqual(['REQ-0045'])
  })
})

describe('what to do with a live post', () => {
  it('follows the task', () => {
    expect(actionFor(null)).toBe('create_done_task')
    expect(actionFor({ status: 'pending', deleted_at: '2026-11-01' })).toBe('create_done_task')
    expect(actionFor({ status: 'in_progress' })).toBe('mark_task_done')
    expect(actionFor({ status: 'delivered' })).toBe('mark_task_done')
    expect(actionFor({ status: 'done' })).toBe('sync_request')
    expect(actionFor({ status: 'invoiced' })).toBe('sync_request')
    expect(actionFor({ status: 'cancelled' })).toBe('none')
  })
})
