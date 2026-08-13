/**
 * Meta webhook processing — signature validation + idempotent event handling.
 *
 * Meta delivers at-least-once, so every event is recorded in webhook_events
 * with a deterministic event_key; a duplicate delivery hits the unique index
 * and is skipped. Route: src/app/api/webhooks/meta/route.ts.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { retrieveAndStoreLead } from './leads'
import { redactTokens } from './client'

/** Validate X-Hub-Signature-256 (sha256 HMAC of the raw body with the app secret). */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET
  if (!appSecret || !signatureHeader) return false
  const [algo, theirHex] = signatureHeader.split('=')
  if (algo !== 'sha256' || !theirHex) return false
  const ourHex = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  const ours = Buffer.from(ourHex, 'hex')
  let theirs: Buffer
  try {
    theirs = Buffer.from(theirHex, 'hex')
  } catch {
    return false
  }
  return ours.length === theirs.length && timingSafeEqual(ours, theirs)
}

export interface WebhookProcessSummary {
  received: number
  processed: number
  duplicates: number
  failed: number
}

/**
 * Process a verified Meta webhook payload. Never throws — Meta must get its
 * 200 quickly or it retries/disables the subscription.
 */
export async function processMetaWebhook(
  admin: SupabaseClient,
  topic: string,
  payload: any,
): Promise<WebhookProcessSummary> {
  const summary: WebhookProcessSummary = { received: 0, processed: 0, duplicates: 0, failed: 0 }

  for (const entry of payload?.entry ?? []) {
    const objectId = String(entry?.id ?? '')
    for (const change of entry?.changes ?? []) {
      summary.received++
      const field = String(change?.field ?? 'unknown')
      const value = change?.value ?? {}

      // Deterministic dedup key per event type.
      let eventKey: string | null = null
      if (field === 'leadgen' && value.leadgen_id) {
        eventKey = `leadgen:${value.leadgen_id}`
      } else {
        // Best-effort key for other fields; entry.time disambiguates re-sends
        // of genuinely distinct events on the same object.
        eventKey = `${field}:${objectId}:${entry?.time ?? ''}:${JSON.stringify(value).slice(0, 120)}`
      }

      // 1. Record (idempotent)
      const { data: eventRow, error: insertErr } = await admin
        .from('webhook_events')
        .insert({
          provider: 'meta',
          topic,
          field,
          object_id: objectId || null,
          event_key: eventKey,
          payload: { entry_id: objectId, time: entry?.time ?? null, value },
          signature_valid: true,
          status: 'received',
        })
        .select('id')
        .single()

      if (insertErr) {
        if ((insertErr as { code?: string }).code === '23505') {
          summary.duplicates++
          continue
        }
        console.warn('[processMetaWebhook] event log insert failed:', insertErr.message)
        summary.failed++
        continue
      }

      // 2. Handle
      try {
        if (field === 'leadgen' && value.leadgen_id) {
          const pageId = String(value.page_id ?? objectId)
          const result = await retrieveAndStoreLead(admin, String(value.leadgen_id), pageId, {
            formId: value.form_id ? String(value.form_id) : undefined,
            adId: value.ad_id ? String(value.ad_id) : undefined,
          })
          if (!result.ok) throw new Error(result.error || 'Lead retrieval failed')
          await admin
            .from('webhook_events')
            .update({ status: 'processed', processed_at: new Date().toISOString() })
            .eq('id', eventRow.id)
          summary.processed++
        } else {
          // Fields we log but don't act on yet (feed, comments, mentions, …)
          await admin
            .from('webhook_events')
            .update({ status: 'skipped', processed_at: new Date().toISOString() })
            .eq('id', eventRow.id)
        }
      } catch (err: any) {
        summary.failed++
        await admin
          .from('webhook_events')
          .update({
            status: 'failed',
            error: redactTokens(err?.message ?? 'Processing failed'),
            attempts: 1,
            processed_at: new Date().toISOString(),
          })
          .eq('id', eventRow.id)
          .then(null, () => {})
      }
    }
  }

  return summary
}
