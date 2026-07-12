'use server'

/**
 * Native push token management (Capacitor iOS/Android — FCM/APNs).
 *
 * Sibling of push/actions.ts (Web Push). Writes are server-action-only (RLS
 * revokes direct writes on native_push_tokens). Graceful pre-migration: swallows
 * the error if migration 025 isn't applied yet, so the mobile app degrades to
 * "no native push" instead of crashing.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser } from '@/lib/permissions/check'

type Result = { ok: true } | { ok: false; error: string }

export async function saveNativePushToken(input: {
  token: string
  platform: 'ios' | 'android'
  userAgent?: string
}): Promise<Result> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not signed in.' }
  if (!input.token || (input.platform !== 'ios' && input.platform !== 'android')) {
    return { ok: false, error: 'Invalid token.' }
  }

  try {
    const admin = createAdminClient()
    // token is UNIQUE — upsert re-homes a device that switched employees.
    const { error } = await admin.from('native_push_tokens').upsert({
      employee_id: me.employeeId,
      token: input.token,
      platform: input.platform,
      user_agent: input.userAgent ?? null,
      last_used_at: new Date().toISOString(),
    }, { onConflict: 'token' })
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not save token.' }
  }
}

export async function removeNativePushToken(token: string): Promise<Result> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not signed in.' }
  try {
    const admin = createAdminClient()
    await admin.from('native_push_tokens').delete()
      .eq('token', token).eq('employee_id', me.employeeId)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not remove token.' }
  }
}
