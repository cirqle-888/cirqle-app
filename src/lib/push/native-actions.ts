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

/** What one tap on a phone notification did. No message text, no ids. */
export interface PushTapTrace {
  /** Names of the fields the phone handed over with the tap. */
  keys: string[]
  /** Page the notification asked for (path only), or null if it carried none we accept. */
  target: string | null
  /** Page the app was on when the tap arrived, and where it was a moment later. */
  from: string
  landed: string
  /** True when the in-app navigation had not arrived and the page was loaded outright. */
  hard: boolean
  /** Milliseconds since this page loaded — small means the tap started the app. */
  sinceLoadMs: number
}

const TRACE_PATH = /^\/[\w\-/]{0,120}$/
const TRACE_KEY = /^[\w.\-]{1,40}$/

/**
 * Write one line to the server log for a tapped phone notification, so a tap
 * that opens the wrong page can be explained without the phone in hand (there
 * is no other window into the phone app). Signed-in users only; every field is
 * checked, so nothing free-form reaches the log.
 */
export async function reportPushTap(trace: PushTapTrace): Promise<void> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return
  const path = (v: unknown) => (typeof v === 'string' && TRACE_PATH.test(v) ? v : null)
  console.log(`[push-tap] ${JSON.stringify({
    keys: Array.isArray(trace?.keys) ? trace.keys.filter(k => typeof k === 'string' && TRACE_KEY.test(k)).slice(0, 16) : [],
    target: path(trace?.target),
    from: path(trace?.from),
    landed: path(trace?.landed),
    hard: trace?.hard === true,
    sinceLoadMs: Number.isFinite(trace?.sinceLoadMs) ? Math.round(trace.sinceLoadMs) : null,
  })}`)
}
