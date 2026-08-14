import { describe, it, expect } from 'vitest'
import {
  buildFeedGrid, tileStatus, firstMediaUrl, isGridMedia,
  reorderGrid, isReadyForApproval,
} from './feed-grid'
import type { PlannedPostLike, PublishedItemLike } from './feed-grid'

const img = (url = 'https://x/a.jpg') => [{ url, type: 'image' }]

const post = (over: Partial<PlannedPostLike> = {}): PlannedPostLike => ({
  id: 'p1', status: 'draft', media: img(), ...over,
})

const live = (over: Partial<PublishedItemLike> = {}): PublishedItemLike => ({
  id: 'm1', thumbnail_url: 'https://x/live.jpg', posted_at: '2026-08-01T10:00:00Z',
  media_product_type: 'FEED', ...over,
})

describe('status as the owner reads it', () => {
  it('splits draft into Draft and Planned by whether it is placed in the grid', () => {
    // The distinction the whole feature rests on: an uploaded creative is a
    // draft; one deliberately positioned is planned.
    expect(tileStatus(post({ status: 'draft', grid_order: null }))).toBe('draft')
    expect(tileStatus(post({ status: 'draft', grid_order: 0 }))).toBe('planned')
  })

  it('maps the approval pipeline through unchanged', () => {
    expect(tileStatus(post({ status: 'awaiting_approval' }))).toBe('awaiting_approval')
    expect(tileStatus(post({ status: 'changes_requested' }))).toBe('changes_requested')
    expect(tileStatus(post({ status: 'approved' }))).toBe('approved')
    expect(tileStatus(post({ status: 'scheduled' }))).toBe('scheduled')
    expect(tileStatus(post({ status: 'published' }))).toBe('published')
    expect(tileStatus(post({ status: 'failed' }))).toBe('failed')
  })

  it('shows mid-publish as Scheduled rather than inventing a state', () => {
    expect(tileStatus(post({ status: 'publishing' }))).toBe('scheduled')
  })

  it('treats an unknown status as a draft, never as progress it has not made', () => {
    expect(tileStatus(post({ status: 'weird_new_state', grid_order: 3 }))).toBe('draft')
  })
})

describe('media extraction', () => {
  it('takes the first usable image', () => {
    expect(firstMediaUrl(img('https://x/1.jpg'))).toEqual({ url: 'https://x/1.jpg', isVideo: false })
  })

  it('flags video so the tile can show a play badge', () => {
    expect(firstMediaUrl([{ url: 'https://x/v.mp4', type: 'video' }]).isVideo).toBe(true)
  })

  it('survives every shape a JSONB column can hold', () => {
    for (const bad of [null, undefined, 'nonsense', 42, {}, [], [null], [{ type: 'image' }]]) {
      expect(firstMediaUrl(bad).url).toBeNull()
    }
  })

  it('skips entries with no url and uses a later one', () => {
    expect(firstMediaUrl([{ type: 'image' }, { url: 'https://x/2.jpg', type: 'image' }]).url)
      .toBe('https://x/2.jpg')
  })
})

describe('what belongs in a profile grid', () => {
  it('keeps feed posts and reels', () => {
    expect(isGridMedia(live({ media_product_type: 'FEED' }))).toBe(true)
    expect(isGridMedia(live({ media_product_type: 'REELS' }))).toBe(true)
  })

  it('excludes stories and ads — neither appears on the profile grid', () => {
    expect(isGridMedia(live({ media_product_type: 'STORY' }))).toBe(false)
    expect(isGridMedia(live({ media_product_type: 'AD' }))).toBe(false)
  })

  it('keeps items with no product type rather than hiding real posts', () => {
    expect(isGridMedia(live({ media_product_type: null }))).toBe(true)
  })
})

describe('grid order', () => {
  it('puts planned tiles above published ones, as Instagram would', () => {
    const { tiles, plannedCount, publishedCount } = buildFeedGrid({
      planned: [post({ id: 'a', grid_order: 0 })],
      published: [live({ id: 'm1' })],
    })
    expect(tiles.map(t => t.kind)).toEqual(['planned', 'published'])
    expect(plannedCount).toBe(1)
    expect(publishedCount).toBe(1)
  })

  it('orders planned tiles by grid_order', () => {
    const { tiles } = buildFeedGrid({
      planned: [
        post({ id: 'c', grid_order: 2 }),
        post({ id: 'a', grid_order: 0 }),
        post({ id: 'b', grid_order: 1 }),
      ],
      published: [],
    })
    expect(tiles.map(t => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts unplaced creatives after placed ones, newest intent first', () => {
    const { tiles } = buildFeedGrid({
      planned: [
        post({ id: 'old', scheduled_at: '2026-08-01T00:00:00Z' }),
        post({ id: 'placed', grid_order: 0 }),
        post({ id: 'new', scheduled_at: '2026-08-09T00:00:00Z' }),
      ],
      published: [],
    })
    expect(tiles.map(t => t.id)).toEqual(['placed', 'new', 'old'])
  })

  it('orders published tiles newest first', () => {
    const { tiles } = buildFeedGrid({
      planned: [],
      published: [
        live({ id: 'older', posted_at: '2026-07-01T00:00:00Z' }),
        live({ id: 'newer', posted_at: '2026-08-01T00:00:00Z' }),
      ],
    })
    expect(tiles.map(t => t.id)).toEqual(['newer', 'older'])
  })

  it('never lists a published post twice, even if it kept its grid_order', () => {
    // A post planned, then published, exists in BOTH tables. Showing it in the
    // planned section as well would double it in the grid.
    const { tiles, plannedCount } = buildFeedGrid({
      planned: [post({ id: 'p', status: 'published', grid_order: 0 })],
      published: [live({ id: 'm' })],
    })
    expect(plannedCount).toBe(0)
    expect(tiles).toHaveLength(1)
  })

  it('drops cancelled posts — they are not part of the plan', () => {
    expect(buildFeedGrid({ planned: [post({ status: 'cancelled', grid_order: 0 })], published: [] }).tiles)
      .toEqual([])
  })

  it('carries caption, hashtags, date and review note onto the tile', () => {
    const { tiles } = buildFeedGrid({
      planned: [post({
        id: 'x', grid_order: 0, status: 'changes_requested',
        caption: 'Hello', hashtags: '#a #b',
        scheduled_at: '2026-08-20T09:00:00Z', review_note: 'Make the logo bigger',
      })],
      published: [],
    })
    expect(tiles[0]).toMatchObject({
      caption: 'Hello', hashtags: '#a #b',
      date: '2026-08-20T09:00:00Z',
      status: 'changes_requested', reviewNote: 'Make the logo bigger',
    })
  })
})

describe('reordering writes only what moved', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves a tile down and renumbers only the affected range', () => {
    const changed = reorderGrid(ids, 'a', 2)   // a b c d → b c a d
    expect(changed).toEqual([
      { id: 'b', grid_order: 0 },
      { id: 'c', grid_order: 1 },
      { id: 'a', grid_order: 2 },
    ])
    // 'd' never moved, so it is not rewritten.
    expect(changed.find(c => c.id === 'd')).toBeUndefined()
  })

  it('moves a tile up', () => {
    expect(reorderGrid(ids, 'd', 0)).toEqual([
      { id: 'd', grid_order: 0 },
      { id: 'a', grid_order: 1 },
      { id: 'b', grid_order: 2 },
      { id: 'c', grid_order: 3 },
    ])
  })

  it('writes nothing when the tile does not actually move', () => {
    expect(reorderGrid(ids, 'b', 1)).toEqual([])
  })

  it('clamps an out-of-range target instead of losing the tile', () => {
    expect(reorderGrid(ids, 'a', 99).map(c => c.id)).toContain('a')
    expect(reorderGrid(ids, 'a', -5)).toEqual([])   // already first
  })

  it('ignores an unknown id rather than corrupting the order', () => {
    expect(reorderGrid(ids, 'nope', 1)).toEqual([])
  })
})

describe('readiness for client approval', () => {
  it('accepts a creative with an image', () => {
    expect(isReadyForApproval(post({ media: img() }))).toBe(true)
  })

  it('rejects an empty placeholder — never send a client a blank tile', () => {
    expect(isReadyForApproval(post({ media: [] }))).toBe(false)
    expect(isReadyForApproval(post({ media: null }))).toBe(false)
  })
})
