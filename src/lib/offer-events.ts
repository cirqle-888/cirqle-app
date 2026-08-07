import type { SupabaseClient } from '@supabase/supabase-js'
import { isFeatureEnabled } from '@/lib/feature-flags'

/**
 * Activity timeline for offer campaigns — tracking/audit/support only.
 *
 * Reuses `offer_change_logs` (log_type 'system', the schema's catch-all) so
 * events render in the exact place staff already read campaign history: the
 * campaign card in the Requests drawer. No new table, no new UI system.
 *
 * Actor identity in notes is CQID / "Client" / "Figma" — never an employee
 * name (privacy rule).
 *
 * Best-effort by contract: a failed event write must never fail the action
 * that emitted it. Flag `feature_offer_timeline` (default on) silences all
 * emitters at once if the volume ever becomes a problem in production.
 */
export async function logCampaignEvent(
  admin: SupabaseClient,
  campaignId: string,
  note: string,
): Promise<void> {
  try {
    if (!campaignId || !note) return
    if (!(await isFeatureEnabled(admin, 'feature_offer_timeline', true))) return
    await admin.from('offer_change_logs').insert({
      campaign_id: campaignId,
      log_type: 'system',
      note,
      // Timeline entries are history, not actionable "changes to reflect in
      // the design" — pre-acknowledged so they never clutter that queue on
      // the campaign card.
      acknowledged: true,
    })
  } catch {
    /* observability, not availability */
  }
}
