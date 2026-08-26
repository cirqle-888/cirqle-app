'use client'

import { getMyNotifications, type NotificationRow } from '@/app/api/notifications/actions'

/**
 * One notifications fetch shared by every consumer on the page.
 *
 * EGRESS: NotificationBell (mounted by the header) and FloatingCommsWidget
 * (mounted by the dashboard layout) both called getMyNotifications() — on their
 * own 300s timers AND on mount, which means twice on every single page
 * navigation. That was ~1,186 requests/day to /rest/v1/notifications against
 * six users, plus an equal number of /auth/v1/user calls, since each server
 * action invocation re-validates the session.
 *
 * Both are already kept live by their own realtime subscriptions and both apply
 * read-state changes optimistically to local state — the poll exists only as a
 * reconnect/missed-event safety net. So collapsing near-simultaneous callers
 * onto one request costs nothing.
 *
 * The window is deliberately short (20s) relative to the 300s poll: a mutation
 * can never be masked by a stale cache entry, so no explicit invalidation is
 * needed. Concurrent callers additionally share the in-flight promise.
 */

type NotificationsResult = Awaited<ReturnType<typeof getMyNotifications>>

// Fetch the larger of the two limits the consumers want (the bell's 30) and let
// each one slice down — so both keep the exact row count they had before.
const SHARED_LIMIT = 30
const TTL_MS = 20_000

let inflight: Promise<NotificationsResult> | null = null
let cached: { at: number; value: NotificationsResult } | null = null

export function fetchSharedNotifications(): Promise<NotificationsResult> {
  const now = Date.now()
  if (cached && now - cached.at < TTL_MS) return Promise.resolve(cached.value)
  if (inflight) return inflight

  inflight = getMyNotifications(SHARED_LIMIT)
    .then(value => {
      // Only cache successes: a transient failure must not be replayed for 20s.
      if (value.ok) cached = { at: Date.now(), value }
      return value
    })
    .finally(() => { inflight = null })

  return inflight
}

/** Unread count over just the rows a given consumer displays. */
export function unreadIn(rows: NotificationRow[], limit: number): number {
  return rows.slice(0, limit).filter(r => !r.read).length
}
