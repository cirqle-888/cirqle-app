import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { processMetaWebhook, verifyMetaSignature } from '@/lib/integrations/meta/webhooks'

export const dynamic = 'force-dynamic'

/**
 * Meta webhook endpoint — https://<app>/api/webhooks/meta
 *
 * GET  — subscription verification handshake: Meta sends hub.mode=subscribe,
 *        hub.verify_token and hub.challenge; we echo the challenge when the
 *        token matches META_WEBHOOK_VERIFY_TOKEN.
 * POST — event deliveries, authenticated by X-Hub-Signature-256 (HMAC-SHA256
 *        of the raw body with the app secret). Invalid signatures get 401 and
 *        are never processed.
 *
 * This path is exempted from session auth in src/lib/supabase/middleware.ts.
 * Setup (Meta App Dashboard → Webhooks): subscribe the Page topic with at
 * least the `leadgen` field, then per-Page POST /{page-id}/subscribed_apps
 * (done automatically by subscribePageWebhooks() after OAuth).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN
  if (mode === 'subscribe' && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200 })
  }
  return new NextResponse('Forbidden', { status: 403 })
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-hub-signature-256')

  if (!verifyMetaSignature(rawBody, signature)) {
    return new NextResponse('Invalid signature', { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return new NextResponse('Bad payload', { status: 400 })
  }

  const topic = String(payload?.object ?? 'unknown') // 'page' | 'instagram' | …
  const admin = createAdminClient()

  try {
    const summary = await processMetaWebhook(admin, topic, payload)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err: any) {
    // Still 200 — Meta retries aggressively and can disable the subscription
    // on repeated failures. The event log carries the error for diagnosis.
    console.error('[webhooks/meta]', err)
    return NextResponse.json({ ok: false })
  }
}
