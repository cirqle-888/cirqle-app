/**
 * The posting queue — what happens AFTER the designer is finished.
 *
 * The social pipeline used to stop at delivery: calendar → request → task →
 * done. Nobody was told the artwork was ready, no caption existed, and nothing
 * recorded that a post went out. Sea Star's Independence Day poster was planned
 * for 15 Aug, finished on time, and sat 13 days past its date with no way to
 * tell whether it had ever been published.
 *
 * This module is the missing state machine. Pure functions only — no imports,
 * no I/O — so the loader, the board and the server actions all read the same
 * rules instead of each re-deriving "is this ready?" slightly differently.
 *
 * TWO CLIENT SHAPES, deliberately both supported:
 *   • Elara — a Social Media Management package, 15 posts committed per cycle.
 *     Progress against that number is meaningful, so it is shown.
 *   • Sea Star Catering — no package, billed per task, no target. Showing
 *     "3 of 0" would be nonsense, so targets are optional throughout.
 */

/**
 * The calendar and the post table describe content with DIFFERENT words, and
 * neither is wrong — the calendar plans in the language a client briefs in
 * ("a poster", "a flyer"), while social_posts stores what Meta's API actually
 * accepts. Writing a calendar value straight into a post violates its CHECK
 * constraint, which is exactly what made the first save attempt fail.
 *
 *   calendar: post reel story carousel video flyer poster blog seo ad email other
 *   post:     image carousel video reel story_image story_video text link
 *
 * Anything unrecognised becomes 'image': this is a design studio, the artwork
 * is a picture, and a wrong-but-valid default keeps the caption saveable rather
 * than blocking her on a taxonomy decision she did not ask to make.
 */
const CALENDAR_TO_POST_TYPE: Record<string, string> = {
  post: 'image',
  poster: 'image',
  flyer: 'image',
  ad: 'image',
  other: 'image',
  carousel: 'carousel',
  reel: 'reel',
  video: 'video',
  story: 'story_image',
  blog: 'link',
  seo: 'link',
  email: 'text',
}

export function postContentTypeFor(calendarType: string | null | undefined): string {
  return CALENDAR_TO_POST_TYPE[(calendarType ?? '').toLowerCase().trim()] ?? 'image'
}

export type PostStage = 'coming_up' | 'to_prepare' | 'ready' | 'posted'

export const POST_STAGES: readonly PostStage[] = ['coming_up', 'to_prepare', 'ready', 'posted']

export const POST_STAGE_LABEL: Record<PostStage, string> = {
  coming_up:  'Coming Up',
  to_prepare: 'To Prepare',
  ready:      'Ready to Post',
  posted:     'Posted',
}

/** What each lane means, in her terms — not the pipeline's. */
export const POST_STAGE_HINT: Record<PostStage, string> = {
  coming_up:  'Still being designed',
  to_prepare: 'Artwork is ready — write the caption',
  ready:      'Caption done — post it on the day',
  posted:     'Published and recorded',
}

export const POST_STAGE_CHIP: Record<PostStage, string> = {
  coming_up:  'bg-secondary text-muted-foreground border-border',
  to_prepare: 'bg-amber-500/15 text-amber-500 border-amber-500/25',
  ready:      'bg-blue-500/15 text-blue-400 border-blue-500/25',
  posted:     'bg-green-500/15 text-green-500 border-green-500/25',
}

/**
 * Statuses that mean the creative EXISTS and can be posted.
 *
 * Two vocabularies meet here and neither can be assumed: task_requests run
 * submitted → started → in_progress → delivered → completed, while tasks run
 * pending → done → invoiced. 'invoiced' counts — billing the client is a
 * stronger signal of completion than 'done', not a weaker one.
 */
export const CREATIVE_READY_REQUEST_STATUSES = ['completed'] as const
export const CREATIVE_READY_TASK_STATUSES = ['done', 'invoiced'] as const

/** Calendar items that should never reach the queue at all. */
export const QUEUE_HIDDEN_ITEM_STATUSES = ['cancelled', 'archived'] as const

export interface CreativeState {
  requestStatus?: string | null
  taskStatus?: string | null
}

/**
 * Is the artwork finished? Either side may be the one that carries the truth —
 * a plan sent straight to a task has no request, and a plan that never left the
 * inbox has no task.
 */
export function isCreativeReady(state: CreativeState): boolean {
  const req = state.requestStatus ?? ''
  const task = state.taskStatus ?? ''
  return (CREATIVE_READY_REQUEST_STATUSES as readonly string[]).includes(req)
    || (CREATIVE_READY_TASK_STATUSES as readonly string[]).includes(task)
}

export interface PostContent {
  caption?: string | null
  hashtags?: string | null
  altText?: string | null
  publishedAt?: string | null
}

const filled = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim().length > 0

/**
 * Which lane a queue entry sits in.
 *
 * Note the order: posted wins over everything, because a post that went out
 * before its artwork was marked done is still posted. Reality beats pipeline.
 */
export function postStageOf(creative: CreativeState, content: PostContent): PostStage {
  if (filled(content.publishedAt)) return 'posted'
  if (!isCreativeReady(creative)) return 'coming_up'
  return isContentReady(content) ? 'ready' : 'to_prepare'
}

/**
 * Content is "ready" once a caption exists. Hashtags and alt text are strongly
 * encouraged by the checklist but never block — an image post with no caption
 * is a mistake, an image post with no hashtags is a choice.
 */
export function isContentReady(content: PostContent): boolean {
  return filled(content.caption)
}

export type Urgency = 'overdue' | 'today' | 'tomorrow' | 'soon' | 'later' | 'none'

export interface UrgencyInfo {
  level: Urgency
  /** Negative = days late, positive = days remaining. */
  days: number
  label: string
}

/**
 * How close a planned post is to its date.
 *
 * Both arguments are ISO yyyy-mm-dd, compared as calendar dates rather than
 * instants: "post it on the 15th" means the day, and a timezone-shifted
 * midnight must not turn that into the 14th.
 */
export function urgencyOf(plannedDate: string | null | undefined, today: string): UrgencyInfo {
  if (!plannedDate) return { level: 'none', days: 0, label: '' }
  const days = daysBetween(today, plannedDate)
  if (days < 0) return { level: 'overdue', days, label: days === -1 ? '1 day late' : `${-days} days late` }
  if (days === 0) return { level: 'today', days, label: 'Post today' }
  if (days === 1) return { level: 'tomorrow', days, label: 'Tomorrow' }
  if (days <= 3) return { level: 'soon', days, label: `In ${days} days` }
  return { level: 'later', days, label: `In ${days} days` }
}

/** Whole days from `from` to `to`, both yyyy-mm-dd. */
function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  return Math.round((b - a) / 86_400_000)
}

export const URGENCY_CHIP: Record<Urgency, string> = {
  overdue:  'bg-red-500/15 text-red-500 border-red-500/25',
  today:    'bg-red-500/15 text-red-500 border-red-500/25',
  tomorrow: 'bg-amber-500/15 text-amber-500 border-amber-500/25',
  soon:     'bg-amber-500/15 text-amber-500 border-amber-500/25',
  later:    'bg-secondary text-muted-foreground border-border',
  none:     'bg-secondary text-muted-foreground border-border',
}

/**
 * Does this need her attention today?
 *
 * The rule the request came with: artwork lands a day or two early, so the
 * reminder must fire on the ARTWORK being ready near its date, not on the date
 * alone. Something already posted is never nagging, however late it went out.
 */
export function needsAttention(stage: PostStage, urgency: UrgencyInfo): boolean {
  if (stage === 'posted' || stage === 'coming_up') return false
  return urgency.level === 'overdue' || urgency.level === 'today'
    || urgency.level === 'tomorrow' || urgency.level === 'soon'
}

export interface ChecklistItem {
  key: 'creative' | 'caption' | 'hashtags' | 'alt_text' | 'posted'
  label: string
  done: boolean
  /** Advisory items shape the score but never block posting. */
  optional: boolean
}

/**
 * The per-post checklist. Derived from what is actually filled in — there is no
 * checklist table, so it can never disagree with the post itself or be left
 * ticked after the caption is deleted.
 */
export function postChecklist(creative: CreativeState, content: PostContent): ChecklistItem[] {
  return [
    { key: 'creative', label: 'Artwork ready',  done: isCreativeReady(creative),  optional: false },
    { key: 'caption',  label: 'Caption written', done: filled(content.caption),   optional: false },
    { key: 'hashtags', label: 'Hashtags added',  done: filled(content.hashtags),  optional: true  },
    { key: 'alt_text', label: 'Alt text added',  done: filled(content.altText),   optional: true  },
    { key: 'posted',   label: 'Posted',          done: filled(content.publishedAt), optional: false },
  ]
}

/** Completed / total, for a compact "3 of 5" progress readout. */
export function checklistProgress(items: ChecklistItem[]): { done: number; total: number } {
  return { done: items.filter(i => i.done).length, total: items.length }
}

export interface CommittedItem {
  serviceId: string
  quantity: number
}

/**
 * How many posts a package actually commits for THIS calendar.
 *
 * A client can hold several active packages at once — Elara holds Social Media
 * Management (Social Media Poster × 15) and Brand Identity Essential (Logo
 * Design × 2). Summing them would promise 17 posts a month, which nobody
 * agreed to. Only items whose service appears on the client's own social
 * calendar count, so the denominator always matches what the queue can fill.
 *
 * Returns null, never 0, when nothing qualifies: no commitment is a different
 * statement from a commitment of none.
 */
export function committedTarget(
  items: CommittedItem[],
  calendarServiceIds: Set<string>,
): number | null {
  let total = 0
  for (const i of items) {
    if (!calendarServiceIds.has(i.serviceId)) continue
    if (i.quantity > 0) total += i.quantity
  }
  return total > 0 ? total : null
}

export interface CycleProgress {
  posted: number
  /** null when the client has no package — Sea Star bills per task. */
  target: number | null
  label: string
}

/**
 * Progress for one client in one cycle.
 *
 * A committed package makes "8 of 15" meaningful. Without one there is no
 * denominator and inventing zero would read as failure, so the count stands
 * alone.
 */
export function cycleProgress(posted: number, target: number | null | undefined): CycleProgress {
  if (typeof target !== 'number' || target <= 0) {
    return { posted, target: null, label: posted === 1 ? '1 posted' : `${posted} posted` }
  }
  return { posted, target, label: `${posted} of ${target} posted` }
}
