/**
 * Comment inbox — one queue across Instagram and Facebook.
 *
 * Replying to people is the part of running an account that Cirqle could not
 * touch: everything else moved here, but comments still meant opening two apps
 * and scrolling. This module is the shared vocabulary for both platforms, which
 * describe the same thing differently:
 *
 *   Instagram  { id, text,    username,  timestamp,    like_count }
 *   Facebook   { id, message, from{...}, created_time, like_count }
 *
 * Pure functions, no imports. The loader, the actions and the UI all decide
 * "does this need a reply?" the same way, because they all ask this.
 */

export type InboxPlatform = 'instagram' | 'facebook_page'

export interface InboxComment {
  id: string
  platform: InboxPlatform
  accountId: string
  /** The post the comment sits on. */
  mediaId: string
  text: string
  authorName: string
  authorId: string | null
  createdAt: string
  likeCount: number
  /** Written by the client's own account — i.e. one of our replies. */
  isOurs: boolean
  parentId: string | null
  replies: InboxComment[]
}

/** Raw Instagram comment, as the Graph API returns it. */
export interface RawIgComment {
  id: string
  text?: string | null
  username?: string | null
  timestamp?: string | null
  like_count?: number | null
  replies?: { data?: RawIgComment[] } | null
}

/** Raw Facebook comment, as the Graph API returns it. */
export interface RawFbComment {
  id: string
  message?: string | null
  from?: { id?: string; name?: string } | null
  created_time?: string | null
  like_count?: number | null
  comments?: { data?: RawFbComment[] } | null
}

/**
 * @param ownHandle the account's own username (IG) or page id (FB), so a reply
 *   we already sent is not mistaken for someone waiting on us.
 */
export function normaliseIgComment(
  raw: RawIgComment,
  accountId: string,
  mediaId: string,
  ownHandle: string,
  parentId: string | null = null,
): InboxComment {
  const username = (raw.username ?? '').trim()
  return {
    id: raw.id,
    platform: 'instagram',
    accountId,
    mediaId,
    text: (raw.text ?? '').trim(),
    authorName: username || 'Instagram user',
    authorId: null,               // IG does not expose a stable commenter id here
    createdAt: raw.timestamp ?? '',
    likeCount: Number(raw.like_count ?? 0),
    isOurs: username.length > 0 && username.toLowerCase() === ownHandle.toLowerCase(),
    parentId,
    replies: (raw.replies?.data ?? []).map(r =>
      normaliseIgComment(r, accountId, mediaId, ownHandle, raw.id)),
  }
}

export function normaliseFbComment(
  raw: RawFbComment,
  accountId: string,
  mediaId: string,
  ownPageId: string,
  parentId: string | null = null,
): InboxComment {
  const fromId = raw.from?.id ?? null
  return {
    id: raw.id,
    platform: 'facebook_page',
    accountId,
    mediaId,
    text: (raw.message ?? '').trim(),
    // A Page cannot always see who commented — without pages_read_user_content
    // `from` is absent entirely, so the name has to degrade rather than crash.
    authorName: raw.from?.name?.trim() || 'Facebook user',
    authorId: fromId,
    createdAt: raw.created_time ?? '',
    likeCount: Number(raw.like_count ?? 0),
    isOurs: fromId != null && fromId === ownPageId,
    parentId,
    replies: (raw.comments?.data ?? []).map(r =>
      normaliseFbComment(r, accountId, mediaId, ownPageId, raw.id)),
  }
}

/**
 * Does this thread still want an answer?
 *
 * The rule is "who spoke last": if the newest message in the thread is theirs,
 * nobody has answered it. A thread we started and they never replied to is NOT
 * waiting on us, and neither is one we have already answered — those are the
 * two ways a naive "has any reply" check gets it wrong.
 *
 * Our own comments never need a reply to ourselves.
 */
export function needsReply(thread: InboxComment): boolean {
  if (thread.isOurs && thread.replies.length === 0) return false
  const last = lastMessage(thread)
  return !last.isOurs
}

/** The most recent message anywhere in the thread, by time then position. */
export function lastMessage(thread: InboxComment): InboxComment {
  let latest = thread
  for (const r of thread.replies) {
    const candidate = lastMessage(r)
    if (candidate.createdAt >= latest.createdAt) latest = candidate
  }
  return latest
}

/** Total messages in a thread, the root included. */
export function threadSize(thread: InboxComment): number {
  return 1 + thread.replies.reduce((n, r) => n + threadSize(r), 0)
}

export type InboxFilter = 'needs_reply' | 'all' | 'answered'

export function filterThreads(
  threads: InboxComment[],
  filter: InboxFilter,
  dismissed: Set<string> = new Set(),
): InboxComment[] {
  if (filter === 'all') return threads
  const waiting = threads.filter(t => needsReply(t) && !dismissed.has(t.id))
  return filter === 'needs_reply'
    ? waiting
    : threads.filter(t => !waiting.includes(t))
}

/**
 * Newest first, which is the order someone answering comments actually wants:
 * the person who just commented is still around to see the reply.
 */
export function sortThreads(threads: InboxComment[]): InboxComment[] {
  return [...threads].sort((a, b) =>
    lastMessage(b).createdAt.localeCompare(lastMessage(a).createdAt))
}

/** How old, in whole hours — the number that decides if a reply is late. */
export function ageInHours(iso: string, nowIso: string): number {
  const a = Date.parse(iso), b = Date.parse(nowIso)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.floor((b - a) / 3_600_000))
}

/**
 * People expect an answer the same day. Past a day it reads as being ignored,
 * so that is where the queue starts calling it late rather than merely open.
 */
export const REPLY_LATE_AFTER_HOURS = 24

export function isLate(thread: InboxComment, nowIso: string): boolean {
  if (!needsReply(thread)) return false
  return ageInHours(lastMessage(thread).createdAt, nowIso) >= REPLY_LATE_AFTER_HOURS
}
