import { requirePermission } from '@/lib/permissions/check'
import { createAdminClient } from '@/lib/supabase/server'
import { snapshotFingerprint } from './snapshot'
import type { ReportConfig, RenderData } from './types'

// Keep the write capability behind its own mutation guard, including view-as.
export async function savePreviewDraft(config: ReportConfig, renderData: RenderData) {
  const edit = await requirePermission('advertising.edit')
  if (!edit.ok) return { ok: false as const, error: edit.error, status: 403 }
  const { data: draft, error } = await createAdminClient().from('ad_report_drafts').insert({
    client_id: config.clientId, created_by: edit.employeeId || null,
    config, config_hash: snapshotFingerprint(config), render_data: renderData,
  }).select('id').single()
  if (error || !draft) return { ok: false as const, error: 'Could not save the preview for approval.', status: 503 }
  return { ok: true as const, draft }
}
