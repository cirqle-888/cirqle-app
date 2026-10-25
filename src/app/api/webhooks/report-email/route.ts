import { NextResponse } from 'next/server'
import { getResend } from '@/lib/email/resend'
import { createAdminClient } from '@/lib/supabase/server'
export async function POST(req: Request) {
  const resend = getResend(), secret = process.env.RESEND_REPORT_WEBHOOK_SECRET
  if (!resend || !secret) return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 503 })
  const payload = await req.text()
  if (payload.length > 1000000) return NextResponse.json({ error: 'Payload too large.' }, { status: 413 })
  let event
  try {
    event = resend.webhooks.verify({ payload, headers: { id: req.headers.get('svix-id') ?? '', timestamp: req.headers.get('svix-timestamp') ?? '', signature: req.headers.get('svix-signature') ?? '' }, webhookSecret: secret })
  } catch { return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 }) }
  const states: Record<string, string> = { 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.failed': 'failed' }
  const state = states[event.type]
  const providerId = (event.data as { email_id?: string }).email_id
  if (!state || !providerId) return NextResponse.json({ ok: true })
  if (!Number.isFinite(Date.parse(event.created_at))) return NextResponse.json({ error: 'Invalid event time.' }, { status: 400 })
  const { error } = await createAdminClient().rpc('record_report_delivery_event', { p_event_id: req.headers.get('svix-id'), p_provider_id: providerId, p_state: state, p_occurred_at: event.created_at })
  return NextResponse.json(error ? { error: 'Could not record event.' } : { ok: true }, { status: error ? 503 : 200 })
}
