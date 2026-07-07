/**
 * Web Push sender (VAPID). Fire-and-forget from createNotification so a
 * device that's closed the tab still gets the alert.
 *
 * Fully optional / graceful: if VAPID env isn't set, migration 021 isn't
 * applied, or a subscription is stale (410/404), it degrades to a no-op and
 * prunes dead endpoints. Free — no paid service.
 */

import 'server-only'
import webpush from 'web-push'
import { createAdminClient } from '@/lib/supabase/admin'

let configured: boolean | null = null
function ensureConfigured(): boolean {
  if (configured !== null) return configured
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  const priv = process.env.VAPID_PRIVATE_KEY
  const subject = process.env.VAPID_SUBJECT || 'mailto:farooq@cirqle.work'
  if (!pub || !priv) { configured = false; return false }
  try {
    webpush.setVapidDetails(subject, pub, priv)
    configured = true
  } catch { configured = false }
  return configured
}

export interface PushPayload {
  title: string
  body?: string
  url?: string
  tag?: string
}

/** Send a push to every registered device of one employee. Never throws. */
export async function sendWebPush(employeeId: string, payload: PushPayload): Promise<void> {
  if (!ensureConfigured()) return
  try {
    const admin = createAdminClient()
    const { data: subs, error } = await admin
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('employee_id', employeeId)
    if (error || !subs?.length) return

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body ?? '',
      url: payload.url ?? '/dashboard',
      tag: payload.tag,
    })

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        )
        void admin.from('push_subscriptions').update({ last_used_at: new Date().toISOString() }).eq('id', s.id)
      } catch (err: unknown) {
        // 404/410 = subscription expired/unsubscribed → prune it.
        const status = (err as { statusCode?: number })?.statusCode
        if (status === 404 || status === 410) {
          void admin.from('push_subscriptions').delete().eq('id', s.id)
        }
      }
    }))
  } catch { /* push is best-effort */ }
}
