/**
 * Push to the phone apps (Capacitor Android / iOS) through Firebase Cloud
 * Messaging. A phone app cannot receive Web Push — its WebView has no push
 * service — so without this a closed app hears nothing.
 *
 * Optional and silent, like Web Push: with Google access not configured it does
 * nothing. How the server proves itself to Google (no stored key in production)
 * is in ./google-auth.ts; the whole setup is in docs/MOBILE_NATIVE.md.
 */

import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { fcmAccess } from './google-auth'
import type { PushPayload } from './send'

/** Send to every phone app this employee is signed in on. Never throws. */
export async function sendNativePush(employeeId: string, payload: PushPayload): Promise<void> {
  try {
    const admin = createAdminClient()
    const { data: tokens, error } = await admin
      .from('native_push_tokens')
      .select('token')
      .eq('employee_id', employeeId)
    // No phone registered: don't ask Google for anything.
    if (error || !tokens?.length) return
    const access = await fcmAccess()
    if (!access) return

    let reported = false
    await Promise.all((tokens as { token: string }[]).map(async ({ token }) => {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${access.projectId}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            message: {
              token,
              notification: { title: payload.title, body: payload.body ?? '' },
              // Read by the app when the notification is tapped, to open the right screen.
              data: { url: payload.url ?? '/dashboard', tag: payload.tag ?? '' },
              android: { priority: 'HIGH', ...(payload.tag ? { notification: { tag: payload.tag } } : {}) },
              apns: { payload: { aps: { sound: 'default', ...(payload.tag ? { 'thread-id': payload.tag } : {}) } } },
            },
          }),
        })
        // 404 / UNREGISTERED: the app was uninstalled or the token rotated — forget it.
        if (res.status === 404) await admin.from('native_push_tokens').delete().eq('token', token)
        else if (res.ok) await admin.from('native_push_tokens').update({ last_used_at: new Date().toISOString() }).eq('token', token)
        else if (!reported) {
          // Anything else is a setup problem (permission, wrong project). Say so
          // once per send — the status and Google's reason only, never a token.
          reported = true
          const reason = await res.json().then((j: { error?: { status?: string; message?: string } }) => j.error?.status ?? j.error?.message, () => undefined)
          console.warn(`[push] Firebase refused a phone push: ${res.status}${reason ? ` ${reason}` : ''}`)
        }
      } catch { /* one device failing must not stop the others */ }
    }))
  } catch { /* push is best-effort */ }
}
