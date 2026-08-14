/**
 * The Instagram feed grid: what a client will actually see.
 *
 * Instagram renders a profile newest-first, top-left, three across. Planning a
 * feed therefore means arranging tiles in that order — so this module builds
 * exactly that sequence from two sources that do not otherwise meet:
 *
 *   planned    social_posts placed in the grid (grid_order), not yet live
 *   published  social_media_items — what is really on the account
 *
 * Pure and framework-free, so the ordering rule is testable and identical in
 * the planner, the client approval view and any export.
 */

/** Statuses as the owner thinks about them, not as the database stores them. */
export type FeedTileStatus =
  | 'draft'
  | 'planned'
  | 'awaiting_approval'
  | 'changes_requested'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'failed'

export const FEED_STATUS_LABEL: Record<FeedTileStatus, string> = {
  draft: 'Draft',
  planned: 'Planned',
  awaiting_approval: 'Client approval pending',
  changes_requested: 'Needs changes',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  failed: 'Failed',
}

/** Tailwind chip classes per status. Kept beside the labels so they agree. */
export const FEED_STATUS_CHIP: Record<FeedTileStatus, string> = {
  draft:             'bg-secondary text-muted-foreground border-border',
  planned:           'bg-violet-500/15 text-violet-600 dark:text-violet-300 border-violet-500/30',
  awaiting_approval: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/30',
  changes_requested: 'bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/30',
  approved:          'bg-blue-500/15 text-blue-600 dark:text-blue-300 border-blue-500/30',
  scheduled:         'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border-indigo-500/30',
  published:         'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/30',
  failed:            'bg-red-500/20 text-red-600 dark:text-red-300 border-red-500/40',
}

/** A planned post, as the database holds it. */
export interface PlannedPostLike {
  id: string
  status: string
  /** [{ url, type }] — the first image is the grid thumbnail. */
  media?: unknown
  caption?: string | null
  hashtags?: string | null
  scheduled_at?: string | null
  grid_order?: number | null
  review_note?: string | null
}

/** A live post pulled back from Instagram. */
export interface PublishedItemLike {
  id: string
  thumbnail_url?: string | null
  media_url?: string | null
  permalink?: string | null
  caption?: string | null
  posted_at?: string | null
  media_type?: string | null
  media_product_type?: string | null
  likes?: number | null
  comments?: number | null
}

export interface FeedTile {
  key: string
  kind: 'planned' | 'published'
  /** Underlying row id — a social_posts id, or a social_media_items id. */
  id: string
  imageUrl: string | null
  status: FeedTileStatus
  caption: string | null
  hashtags: string | null
  /** When it publishes (planned) or did publish (published). */
  date: string | null
  permalink: string | null
  reviewNote: string | null
  likes: number | null
  comments: number | null
  /** True when the tile is a video/reel rather than a still. */
  isVideo: boolean
}

/**
 * Turn a stored status into what the owner sees.
 *
 * 'draft' splits in two: a creative merely uploaded is a **Draft**, but one the
 * owner has deliberately placed in the grid is **Planned**. The distinction is
 * the whole point of planning visually before scheduling, and it is why
 * grid_order exists separately from scheduled_at.
 */
export function tileStatus(post: PlannedPostLike): FeedTileStatus {
  switch (post.status) {
    case 'published':        return 'published'
    case 'scheduled':        return 'scheduled'
    case 'approved':         return 'approved'
    case 'awaiting_approval':return 'awaiting_approval'
    case 'changes_requested':return 'changes_requested'
    case 'failed':           return 'failed'
    case 'publishing':       return 'scheduled'
    case 'draft':
      return post.grid_order != null ? 'planned' : 'draft'
    default:
      // Unknown status: show it as a draft rather than implying progress it
      // has not made.
      return 'draft'
  }
}

/** First usable image URL out of the media JSONB. */
export function firstMediaUrl(media: unknown): { url: string | null; isVideo: boolean } {
  if (!Array.isArray(media)) return { url: null, isVideo: false }
  for (const m of media) {
    if (!m || typeof m !== 'object') continue
    const rec = m as Record<string, unknown>
    const url = typeof rec.url === 'string' ? rec.url : null
    if (!url) continue
    const type = typeof rec.type === 'string' ? rec.type : ''
    return { url, isVideo: type === 'video' }
  }
  return { url: null, isVideo: false }
}

/** Instagram shows stills and reels in the grid, but never stories. */
export function isGridMedia(item: PublishedItemLike): boolean {
  const product = (item.media_product_type ?? '').toUpperCase()
  if (product === 'STORY') return false
  if (product === 'AD') return false
  return true
}

export interface BuildGridInput {
  planned: PlannedPostLike[]
  published: PublishedItemLike[]
}

/**
 * The grid, in the exact order Instagram would render it.
 *
 * Planned tiles come first — they are the future, and Instagram puts the newest
 * at the top-left. Within planned, `grid_order` decides; a tile without one
 * sorts after those with one, by date, so a freshly uploaded creative appears
 * predictably rather than jumping about.
 *
 * Published tiles follow, newest first, and are read-only history.
 */
export function buildFeedGrid(input: BuildGridInput): {
  tiles: FeedTile[]
  plannedCount: number
  publishedCount: number
} {
  const planned = [...input.planned]
    // A published post is history — it belongs to the published section, even
    // if it still carries a grid_order from when it was planned.
    .filter(p => p.status !== 'published' && p.status !== 'cancelled')
    .sort((a, b) => {
      const ao = a.grid_order, bo = b.grid_order
      if (ao != null && bo != null) return ao - bo
      if (ao != null) return -1
      if (bo != null) return 1
      // Neither placed: newest intent first, mirroring the grid's direction.
      return String(b.scheduled_at ?? '').localeCompare(String(a.scheduled_at ?? ''))
    })
    .map((p): FeedTile => {
      const { url, isVideo } = firstMediaUrl(p.media)
      return {
        key: `planned:${p.id}`,
        kind: 'planned',
        id: p.id,
        imageUrl: url,
        status: tileStatus(p),
        caption: p.caption ?? null,
        hashtags: p.hashtags ?? null,
        date: p.scheduled_at ?? null,
        permalink: null,
        reviewNote: p.review_note ?? null,
        likes: null,
        comments: null,
        isVideo,
      }
    })

  const published = input.published
    .filter(isGridMedia)
    .sort((a, b) => String(b.posted_at ?? '').localeCompare(String(a.posted_at ?? '')))
    .map((m): FeedTile => ({
      key: `published:${m.id}`,
      kind: 'published',
      id: m.id,
      imageUrl: m.thumbnail_url || m.media_url || null,
      status: 'published',
      caption: m.caption ?? null,
      hashtags: null,
      date: m.posted_at ?? null,
      permalink: m.permalink ?? null,
      reviewNote: null,
      likes: m.likes ?? null,
      comments: m.comments ?? null,
      isVideo: (m.media_type ?? '').toUpperCase().includes('VIDEO'),
    }))

  return {
    tiles: [...planned, ...published],
    plannedCount: planned.length,
    publishedCount: published.length,
  }
}

/**
 * New grid_order values after dragging `movedId` to `toIndex`.
 *
 * Returns only the rows that actually changed, so a reorder writes three rows
 * rather than thirty. Positions are renumbered from 0 with no gaps, which keeps
 * later inserts predictable.
 */
export function reorderGrid(
  plannedIds: string[],
  movedId: string,
  toIndex: number,
): { id: string; grid_order: number }[] {
  const from = plannedIds.indexOf(movedId)
  if (from === -1) return []
  const next = [...plannedIds]
  next.splice(from, 1)
  next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, movedId)

  const changed: { id: string; grid_order: number }[] = []
  next.forEach((id, i) => {
    if (plannedIds[i] !== id) changed.push({ id, grid_order: i })
  })
  return changed
}

/**
 * Is this planned post ready to be shown to a client?
 *
 * A tile with no image is a placeholder, not a proposal — sending one for
 * approval wastes the client's attention and makes the agency look sloppy.
 */
export function isReadyForApproval(post: PlannedPostLike): boolean {
  return firstMediaUrl(post.media).url != null
}
