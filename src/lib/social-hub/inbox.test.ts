import { describe, it, expect } from 'vitest'
import {
  normaliseIgComment, normaliseFbComment, needsReply, lastMessage, threadSize,
  filterThreads, sortThreads, ageInHours, isLate, REPLY_LATE_AFTER_HOURS,
  type InboxComment,
} from './inbox'

const IG_OWN = 'mezza_foods'
const FB_PAGE = '1687729758200802'

describe('normaliseIgComment', () => {
  it('reads the real shape Instagram returns', () => {
    // Taken verbatim from a live probe against mezza_foods.
    const c = normaliseIgComment(
      { id: '17867245041512227', text: '👍👍', username: 'aslampalayil', timestamp: '2026-04-02T07:10:21+0000', like_count: 0 },
      'acct', 'media', IG_OWN,
    )
    expect(c.text).toBe('👍👍')
    expect(c.authorName).toBe('aslampalayil')
    expect(c.isOurs).toBe(false)
    expect(c.platform).toBe('instagram')
  })

  it('recognises our own comment as ours, whatever the casing', () => {
    const c = normaliseIgComment({ id: '1', text: 'thanks!', username: 'MEZZA_Foods' }, 'a', 'm', IG_OWN)
    expect(c.isOurs).toBe(true)
  })

  it('survives a comment with no text or author', () => {
    const c = normaliseIgComment({ id: '1' }, 'a', 'm', IG_OWN)
    expect(c.text).toBe('')
    expect(c.authorName).toBe('Instagram user')
    expect(c.isOurs).toBe(false)   // absent username must not match ours
  })

  it('nests replies and records the parent', () => {
    const c = normaliseIgComment(
      { id: 'root', text: 'hi', username: 'someone', replies: { data: [{ id: 'r1', text: 'hello', username: IG_OWN }] } },
      'a', 'm', IG_OWN,
    )
    expect(c.replies).toHaveLength(1)
    expect(c.replies[0].parentId).toBe('root')
    expect(c.replies[0].isOurs).toBe(true)
  })
})

describe('normaliseFbComment', () => {
  it('maps message/from/created_time onto the shared shape', () => {
    const c = normaliseFbComment(
      { id: '1', message: 'nice', from: { id: '999', name: 'A Person' }, created_time: '2026-08-01T10:00:00+0000', like_count: 3 },
      'acct', 'post', FB_PAGE,
    )
    expect(c.text).toBe('nice')
    expect(c.authorName).toBe('A Person')
    expect(c.likeCount).toBe(3)
    expect(c.isOurs).toBe(false)
  })

  it('treats a comment from the Page itself as ours', () => {
    const c = normaliseFbComment({ id: '1', message: 'thanks', from: { id: FB_PAGE, name: 'Mezza' } }, 'a', 'p', FB_PAGE)
    expect(c.isOurs).toBe(true)
  })

  it('degrades when `from` is missing rather than crashing', () => {
    // Facebook omits `from` entirely without pages_read_user_content.
    const c = normaliseFbComment({ id: '1', message: 'hi' }, 'a', 'p', FB_PAGE)
    expect(c.authorName).toBe('Facebook user')
    expect(c.authorId).toBeNull()
    expect(c.isOurs).toBe(false)
  })
})

const mk = (over: Partial<InboxComment>): InboxComment => ({
  id: 'x', platform: 'instagram', accountId: 'a', mediaId: 'm', text: '',
  authorName: 'someone', authorId: null, createdAt: '2026-08-01T10:00:00Z',
  likeCount: 0, isOurs: false, parentId: null, replies: [], ...over,
})

describe('needsReply', () => {
  it('an unanswered comment from someone else is waiting', () => {
    expect(needsReply(mk({}))).toBe(true)
  })

  it('a comment we already answered is not', () => {
    expect(needsReply(mk({
      replies: [mk({ id: 'r', isOurs: true, createdAt: '2026-08-01T11:00:00Z' })],
    }))).toBe(false)
  })

  it('is true again when they come back after our reply', () => {
    // The case a naive "has any reply from us" check gets wrong.
    expect(needsReply(mk({
      replies: [
        mk({ id: 'r1', isOurs: true, createdAt: '2026-08-01T11:00:00Z' }),
        mk({ id: 'r2', isOurs: false, createdAt: '2026-08-01T12:00:00Z' }),
      ],
    }))).toBe(true)
  })

  it('our own comment with no replies never asks for an answer', () => {
    expect(needsReply(mk({ isOurs: true }))).toBe(false)
  })

  it('goes by who spoke LAST, not by reply count', () => {
    const t = mk({ replies: [
      mk({ id: 'a', isOurs: false, createdAt: '2026-08-01T11:00:00Z' }),
      mk({ id: 'b', isOurs: true, createdAt: '2026-08-01T12:00:00Z' }),
    ] })
    expect(needsReply(t)).toBe(false)
  })
})

describe('lastMessage / threadSize', () => {
  it('finds the newest message however deep', () => {
    const t = mk({ id: 'root', replies: [mk({ id: 'r', createdAt: '2026-08-02T09:00:00Z',
      replies: [mk({ id: 'rr', createdAt: '2026-08-03T09:00:00Z' })] })] })
    expect(lastMessage(t).id).toBe('rr')
  })

  it('counts every message including the root', () => {
    expect(threadSize(mk({ replies: [mk({ id: 'a' }), mk({ id: 'b', replies: [mk({ id: 'c' })] })] }))).toBe(4)
  })
})

describe('filterThreads', () => {
  const waiting = mk({ id: 'w' })
  const answered = mk({ id: 'a', replies: [mk({ id: 'r', isOurs: true, createdAt: '2026-08-01T11:00:00Z' })] })

  it('needs_reply keeps only what is waiting', () => {
    expect(filterThreads([waiting, answered], 'needs_reply').map(t => t.id)).toEqual(['w'])
  })

  it('answered is the complement', () => {
    expect(filterThreads([waiting, answered], 'answered').map(t => t.id)).toEqual(['a'])
  })

  it('all keeps everything', () => {
    expect(filterThreads([waiting, answered], 'all')).toHaveLength(2)
  })

  it('a dismissed thread stops asking, and moves to answered', () => {
    const dismissed = new Set(['w'])
    expect(filterThreads([waiting, answered], 'needs_reply', dismissed)).toHaveLength(0)
    expect(filterThreads([waiting, answered], 'answered', dismissed).map(t => t.id)).toEqual(['w', 'a'])
  })
})

describe('sortThreads', () => {
  it('puts the most recent activity first, not the oldest root', () => {
    // An old thread someone just replied to belongs at the top.
    const old = mk({ id: 'old', createdAt: '2026-07-01T00:00:00Z',
      replies: [mk({ id: 'r', createdAt: '2026-08-09T00:00:00Z' })] })
    const recent = mk({ id: 'recent', createdAt: '2026-08-05T00:00:00Z' })
    expect(sortThreads([recent, old]).map(t => t.id)).toEqual(['old', 'recent'])
  })
})

describe('ageInHours / isLate', () => {
  const NOW = '2026-08-02T12:00:00Z'

  it('measures whole hours', () => {
    expect(ageInHours('2026-08-02T09:30:00Z', NOW)).toBe(2)
  })

  it('never goes negative for a future timestamp', () => {
    expect(ageInHours('2026-08-03T00:00:00Z', NOW)).toBe(0)
  })

  it('returns 0 rather than NaN on an unparseable date', () => {
    expect(ageInHours('', NOW)).toBe(0)
  })

  it(`calls a waiting comment late after ${REPLY_LATE_AFTER_HOURS}h`, () => {
    expect(isLate(mk({ createdAt: '2026-08-01T11:00:00Z' }), NOW)).toBe(true)
    expect(isLate(mk({ createdAt: '2026-08-02T09:00:00Z' }), NOW)).toBe(false)
  })

  it('never calls an answered thread late, however old', () => {
    const answered = mk({ createdAt: '2020-01-01T00:00:00Z',
      replies: [mk({ id: 'r', isOurs: true, createdAt: '2020-01-02T00:00:00Z' })] })
    expect(isLate(answered, NOW)).toBe(false)
  })
})
