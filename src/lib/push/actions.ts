'use server'

/**
 * Web Push subscription management. Writes are server-action-only (RLS revokes
 * direct writes on push_subscriptions). Graceful pre-migration: swallows the
 * error if migration 021 isn't applied yet.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser } from '@/lib/permissions/check'

type Result = { ok: true } | { ok: false; error: string }

export async function savePushSubscription(input: {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string
}): Promise<Result> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not signed in.' }
  if (!input.endpoint || !input.p256dh || !input.auth) return { ok: false, error: 'Invalid subscription.' }

  try {
    const admin = createAdminClient()
    // endpoint is UNIQUE — upsert re-homes a device that switched employees.
    const { error } = await admin.from('push_subscriptions').upsert({
      employee_id: me.employeeId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      user_agent: input.userAgent ?? null,
      last_used_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not save subscription.' }
  }
}

export async function removePushSubscription(endpoint: string): Promise<Result> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not signed in.' }
  try {
    const admin = createAdminClient()
    await admin.from('push_subscriptions').delete()
      .eq('endpoint', endpoint).eq('employee_id', me.employeeId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not remove subscription.' }
  }
}
