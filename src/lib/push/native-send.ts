/**
 * Push to the phone apps (Capacitor Android / iOS) through Firebase Cloud
 * Messaging. A phone app cannot receive Web Push — its WebView has no push
 * service — so without this a closed app hears nothing.
 *
 * Optional and silent, like Web Push: with no FCM_SERVICE_ACCOUNT configured it
 * does nothing. Setup is in docs/MOBILE_NATIVE.md (Firebase project,
 * google-services.json in the Android app, and the service-account JSON in
 * the FCM_SERVICE_ACCOUNT environment variable).
 *
 * No SDK: the HTTP v1 API needs only a short-lived access token, signed here
 * with Node's own crypto from the service account's private key.
 */

import 'server-only'
import { createSign } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import type { PushPayload } from './send'

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

let account: ServiceAccount | null | undefined
function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account
  account = null
  const raw = process.env.FCM_SERVICE_ACCOUNT
  if (!raw) return account
  try {
    // Accepts the JSON itself or its base64 — a multi-line key is awkward in some env editors.
    const parsed = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as Partial<ServiceAccount>
    if (parsed.project_id && parsed.client_email && parsed.private_key) {
      account = { project_id: parsed.project_id, client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, '\n') }
    }
  } catch { /* malformed — stays off */ }
  return account
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url')

let cached: { token: string; expires: number } | null = null
async function accessToken(sa: ServiceAccount): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.expires - 60 > now) return cached.token
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return null
  const json = await res.json() as { access_token?: string; expires_in?: number }
  if (!json.access_token) return null
  cached = { token: json.access_token, expires: now + (json.expires_in ?? 3600) }
  return cached.token
}

/** Send to every phone app this employee is signed in on. Never throws. */
export async function sendNativePush(employeeId: string, payload: PushPayload): Promise<void> {
  const sa = serviceAccount()
  if (!sa) return
  try {
    const admin = createAdminClient()
    const { data: tokens, error } = await admin
      .from('native_push_tokens')
      .select('token')
      .eq('employee_id', employeeId)
    if (error || !tokens?.length) return
    const bearer = await accessToken(sa)
    if (!bearer) return

    await Promise.all((tokens as { token: string }[]).map(async ({ token }) => {
      try {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
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
      } catch { /* one device failing must not stop the others */ }
    }))
  } catch { /* push is best-effort */ }
}
