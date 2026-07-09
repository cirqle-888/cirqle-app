/**
 * Event-Driven Architecture for Advertising ERP
 * 
 * Centralized event publishing. Future modules (AI, Webhooks, Notifications) 
 * will subscribe to this event bus or hook into these methods.
 */

import { createAdminClient } from '@/lib/supabase/server'

export type AdEventType = 
  | 'campaign_created'
  | 'campaign_updated'
  | 'campaign_mapped'
  | 'campaign_unmapped'
  | 'budget_changed'
  | 'provider_connected'
  | 'provider_disconnected'
  | 'sync_started'
  | 'sync_completed'
  | 'sync_failed'
  | 'metrics_imported'
  | 'approval_granted'
  | 'approval_rejected'
  | 'job_created'
  | 'job_started'
  | 'job_completed'
  | 'job_failed'
  | 'retry_started'
  | 'retry_completed'
  | 'token_refreshed'
  | 'report_generated'
  | 'ai_analysis_started'
  | 'ai_analysis_completed'
  | 'benchmark_updated'
  | 'forecast_generated'
  | 'health_score_generated'

export interface AdEventPayload {
  projectId?: string
  connectionId?: string
  employeeId?: string
  metadata?: any
}

/**
 * Publishes an advertising event.
 * Currently writes directly to ad_events. In the future, this can push to
 * a queue, trigger webhooks, or notify AI modules.
 */
export async function publishAdEvent(eventType: AdEventType, payload: AdEventPayload) {
  const supabase = createAdminClient()

  if (payload.projectId) {
    // Legacy logging for campaign timeline
    await supabase.from('ad_events').insert({
      project_id: payload.projectId,
      event_type: eventType,
      created_by: payload.employeeId || null,
      metadata: payload.metadata || {}
    })
  }

  // Future: Switch case for webhooks / notification engine triggers based on eventType
  if (eventType === 'sync_failed') {
    // Notify admin
  }
}

/**
 * Publishes MULTIPLE advertising events (batched).
 */
export async function publishAdEventsBatch(events: { eventType: AdEventType; payload: AdEventPayload }[]) {
  const supabase = createAdminClient()

  const validEvents = events.filter(e => e.payload.projectId)
  if (!validEvents.length) return

  const rows = validEvents.map(e => ({
    project_id: e.payload.projectId,
    event_type: e.eventType,
    created_by: e.payload.employeeId || null,
    metadata: e.payload.metadata || {}
  }))

  await supabase.from('ad_events').insert(rows)

  for (const e of events) {
    if (e.eventType === 'sync_failed') {
      // Notify admin
    }
  }
}

