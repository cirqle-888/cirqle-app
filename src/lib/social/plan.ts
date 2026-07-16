/**
 * Social Media Calendar — pure domain helpers (no Supabase, unit-tested).
 *
 * The planner's one integration rule: a pushed item becomes a REAL
 * task_request (tagged via task_requests.social_meta) and from then on the
 * pipeline owns it — the calendar only *displays* live progress read through
 * the item → request → promoted-task join. resolveItemProgress() is that
 * single display mapping.
 */

export const CONTENT_TYPES = ['post', 'reel', 'story', 'carousel', 'video', 'flyer', 'other'] as const
export type ContentType = typeof CONTENT_TYPES[number]

export const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  post: 'Post', reel: 'Reel', story: 'Story', carousel: 'Carousel',
  video: 'Video', flyer: 'Flyer', other: 'Other',
}

/** Chip tint per content type (tailwind classes, house palette). */
export const CONTENT_TYPE_CHIP: Record<ContentType, string> = {
  post:     'bg-violet-500/15 text-violet-400 border-violet-500/25',
  reel:     'bg-pink-500/15 text-pink-400 border-pink-500/25',
  story:    'bg-amber-500/15 text-amber-500 border-amber-500/25',
  carousel: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  video:    'bg-red-500/15 text-red-400 border-red-500/25',
  flyer:    'bg-teal-500/15 text-teal-400 border-teal-500/25',
  other:    'bg-secondary text-muted-foreground border-border',
}

export const PLATFORMS = ['instagram', 'facebook', 'youtube', 'linkedin', 'tiktok', 'x', 'whatsapp'] as const
export type Platform = typeof PLATFORMS[number]

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube',
  linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', whatsapp: 'WhatsApp',
}

/** Short badge text, e.g. "IG" — used on tight calendar cells. */
export const PLATFORM_SHORT: Record<Platform, string> = {
  instagram: 'IG', facebook: 'FB', youtube: 'YT',
  linkedin: 'LI', tiktok: 'TT', x: 'X', whatsapp: 'WA',
}

export function platformLabels(platforms: string[] | null | undefined, short = false): string {
  const map = short ? PLATFORM_SHORT : PLATFORM_LABEL
  return (platforms ?? [])
    .map(p => map[p as Platform] ?? p)
    .join(short ? '·' : ', ')
}

// ── Request description composer ─────────────────────────────────────────────

export interface PlanItemInput {
  title: string
  contentType: string
  platforms: string[]
  scheduledDate: string          // YYYY-MM-DD
  caption?: string | null
  notes?: string | null
  calendarTitle?: string | null  // e.g. "July content plan"
}

/**
 * Compose the task_request description for a pushed item. Mirrors the style
 * of the request → task description block (labelled sections joined by
 * blank lines), so the brief reads naturally in the Requests drawer and on
 * the prefilled Add Task form after promotion.
 */
export function composeRequestDescription(item: PlanItemInput): string {
  const type = CONTENT_TYPE_LABEL[item.contentType as ContentType] ?? item.contentType
  const parts: string[] = [
    `Social media ${type.toLowerCase()} planned for ${item.scheduledDate}` +
      (item.calendarTitle ? ` (${item.calendarTitle})` : ''),
  ]
  if (item.platforms.length > 0) parts.push(`Platforms: ${platformLabels(item.platforms)}`)
  if (item.caption?.trim()) parts.push(`Caption / copy:\n${item.caption.trim()}`)
  if (item.notes?.trim()) parts.push(`Notes:\n${item.notes.trim()}`)
  return parts.join('\n\n')
}

/** The social_meta payload written onto the created task_request. */
export function buildSocialMeta(input: {
  calendarId: string; itemId: string; contentType: string; platforms: string[]; scheduledDate: string
}) {
  return {
    calendar_id: input.calendarId,
    item_id: input.itemId,
    content_type: input.contentType,
    platforms: input.platforms,
    scheduled_date: input.scheduledDate,
  }
}

// ── Live progress resolution (item + joined request → one display state) ─────

export type ItemProgress =
  | 'planned'      // not yet sent to Requests
  | 'requested'    // request exists, not yet promoted to a task
  | 'in_progress'  // promoted; task pending/in_progress (or request says so)
  | 'delivered'    // task delivered — under client review
  | 'done'         // task done/invoiced/paid or request completed
  | 'cancelled'    // item cancelled, or its request/task cancelled/rejected

export const PROGRESS_LABEL: Record<ItemProgress, string> = {
  planned: 'Planned', requested: 'In Requests', in_progress: 'In Progress',
  delivered: 'Under Review', done: 'Completed', cancelled: 'Cancelled',
}

export const PROGRESS_CHIP: Record<ItemProgress, string> = {
  planned:     'bg-secondary text-muted-foreground border-border',
  requested:   'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_progress: 'bg-amber-500/15 text-amber-500 border-amber-500/25',
  delivered:   'bg-purple-500/15 text-purple-400 border-purple-500/25',
  done:        'bg-green-500/15 text-green-500 border-green-500/25',
  cancelled:   'bg-red-500/15 text-red-400 border-red-500/25',
}

export interface LinkedRequestView {
  status: string                                   // task_requests.status
  promoted_task?: { status: string } | null
}

/**
 * Request statuses the planner must never write to: already closed, or
 * already finished-and-client-notified. Editing or cancelling one of these
 * from the calendar would rewrite a record the client has already seen.
 */
export const TERMINAL_REQUEST_STATUSES = ['completed', 'delivered', 'cancelled', 'rejected', 'archived'] as const

export function isTerminalRequestStatus(status: string | null | undefined): boolean {
  return !!status && (TERMINAL_REQUEST_STATUSES as readonly string[]).includes(status)
}

/** Statuses whose linked request is closed — the item may be re-planned. */
export function isClosedRequestStatus(status: string | null | undefined): boolean {
  return status === 'cancelled' || status === 'rejected' || status === 'archived'
}

/**
 * One state for the calendar chip, derived from the authored item status and
 * whatever the pipeline currently says. The request's own status is already
 * task-driven post-promotion (task-sync), so it is authoritative here.
 */
export function resolveItemProgress(
  itemStatus: string,
  request: LinkedRequestView | null | undefined,
): ItemProgress {
  if (itemStatus === 'cancelled') return 'cancelled'
  if (!request) return 'planned'
  const rs = request.status
  // 'archived' is terminal in the inbox too — without this it would fall
  // through to 'requested' and the chip would claim the item is still queued.
  if (rs === 'rejected' || rs === 'cancelled' || rs === 'archived') return 'cancelled'
  if (rs === 'completed') return 'done'
  if (rs === 'delivered') return 'delivered'
  if (request.promoted_task) {
    const ts = request.promoted_task.status
    if (ts === 'done' || ts === 'invoiced' || ts === 'paid') return 'done'
    if (ts === 'delivered') return 'delivered'
    if (ts === 'cancelled') return 'cancelled'
    return 'in_progress'
  }
  if (rs === 'started' || rs === 'in_progress' || rs === 'waiting_for_content' || rs === 'revision_requested') {
    return 'in_progress'
  }
  return 'requested'   // submitted / under_review / approved — sitting in the inbox
}
