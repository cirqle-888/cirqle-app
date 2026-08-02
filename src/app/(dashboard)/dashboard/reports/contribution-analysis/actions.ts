'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnyPermission, requireAdmin } from '@/lib/permissions/check'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

// Free-form layout blob: column order, visibility (groups), frozen columns,
// grouping + sort. Stored as JSONB so new keys need no schema change.
export type ReportLayout = Record<string, unknown>

/**
 * Save the caller's PERSONAL layout for a report. Any user who can view
 * reports (admins always can) may save their own. One row per (user, report) —
 * updated in place if it already exists.
 */
export async function savePersonalReportLayout(
  reportName: string,
  layoutJson: ReportLayout,
): Promise<ActionResult> {
  const auth = await requireAnyPermission(['reports.view'])
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await admin
    .from('report_layouts')
    .select('id')
    .eq('user_id', auth.employeeId)
    .eq('report_name', reportName)
    .maybeSingle()
  if (selErr) return { ok: false, error: selErr.message }

  if (existing?.id) {
    const { error } = await admin
      .from('report_layouts')
      .update({ layout_json: layoutJson, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) return { ok: false, error: error.message }
  } else {
    const { error } = await admin.from('report_layouts').insert({
      user_id: auth.employeeId,
      report_name: reportName,
      layout_json: layoutJson,
      is_system_default: false,
    })
    if (error) return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Save the company-wide SYSTEM DEFAULT layout for a report. Admin only.
 * Exactly one system row per report (user_id NULL) — updated in place.
 * Used for new users, users with no personal layout, and "Reset to System".
 */
export async function saveSystemReportLayout(
  reportName: string,
  layoutJson: ReportLayout,
): Promise<ActionResult> {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await admin
    .from('report_layouts')
    .select('id')
    .is('user_id', null)
    .eq('report_name', reportName)
    .eq('is_system_default', true)
    .maybeSingle()
  if (selErr) return { ok: false, error: selErr.message }

  if (existing?.id) {
    const { error } = await admin
      .from('report_layouts')
      .update({ layout_json: layoutJson, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) return { ok: false, error: error.message }
  } else {
    const { error } = await admin.from('report_layouts').insert({
      user_id: null,
      report_name: reportName,
      layout_json: layoutJson,
      is_system_default: true,
    })
    if (error) return { ok: false, error: error.message }
  }
  return { ok: true }
}
