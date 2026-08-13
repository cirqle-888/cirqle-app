'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireAnyPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { revalidatePath } from 'next/cache'
import { buildAgencyRollups } from '@/lib/integrations/meta/aggregate'
import { generateInsights, type MetaNarrative } from '@/lib/integrations/meta/ai-insights'
import { evaluateMetaAlerts } from '@/lib/integrations/meta/alerts'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const REVALIDATE = '/dashboard/agency'

/** Generate agency-wide AI insights over the current window (on demand). */
export async function generateAgencyInsights(days = 30): Promise<ActionResult<MetaNarrative>> {
  const guard = await requireAnyPermission([PERMS.REPORTS_VIEW, PERMS.SOCIAL_VIEW_INSIGHTS, PERMS.ADVERTISING_VIEW])
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { rollups, totals } = await buildAgencyRollups(admin, days)
  // Pass only the aggregate facts (no PII) to the model.
  const facts = {
    scope: 'agency',
    days,
    totals,
    topClients: rollups.slice(0, 8).map((r) => ({
      client: r.clientName, reach: r.reach, reachDeltaPct: r.reachDeltaPct,
      leads: r.leads, leadsDeltaPct: r.leadsDeltaPct, spend: r.spend, cpl: r.cpl, roas: r.roas, health: r.health,
    })),
    // Give the model a client-agnostic rollup shape so ruleBasedNarrative works too.
    rollup: {
      reach: totals.totalReach, views: totals.totalViews, interactions: 0,
      followers: null, contentPublished: totals.contentPublished,
      reachDeltaPct: null, leads: totals.totalLeads, leadsDeltaPct: null,
      spend: totals.totalSpend, adLeads: 0, cpl: totals.avgCpl, ctr: null, roas: null,
    },
    leadsByCampaign: {},
  }
  const narrative = await generateInsights(admin, 'agency', facts)
  return { ok: true, data: narrative }
}

/** Run the alert evaluator now (manual trigger). */
export async function runAlertsNow(): Promise<ActionResult<{ evaluated: number; triggered: number }>> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_COMPANY)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const res = await evaluateMetaAlerts(admin)
  return { ok: true, data: res }
}

export interface AlertRuleInput {
  id?: string | null
  client_id: string | null
  metric: string
  threshold: number
  is_active?: boolean
}

const METRICS = ['cpl_above', 'leads_drop_pct', 'reach_drop_pct', 'spend_increase_pct', 'stale_sync_hours', 'roas_below', 'ctr_below']

export async function saveAlertRule(input: AlertRuleInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_COMPANY)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!METRICS.includes(input.metric)) return { ok: false, error: 'Unknown metric.' }
  if (!Number.isFinite(input.threshold) || input.threshold < 0) return { ok: false, error: 'Enter a valid threshold.' }

  const admin = createAdminClient()
  const row = { client_id: input.client_id || null, metric: input.metric, threshold: input.threshold, is_active: input.is_active ?? true }
  let id = input.id ?? null
  if (id) {
    const { error } = await admin.from('performance_alert_rules').update(row).eq('id', id)
    if (error) return { ok: false, error: error.message }
  } else {
    const { data, error } = await admin.from('performance_alert_rules').insert({ ...row, created_by: guard.employeeId ?? null }).select('id').single()
    if (error) return { ok: false, error: error.message }
    id = (data as { id: string }).id
  }
  void logActivity({ actorId: guard.employeeId, entityType: 'setting', entityId: id, action: input.id ? 'edited' : 'created', category: 'crm', detail: [{ field: 'alert_rule', from: null, to: `${row.metric}=${row.threshold}` }] })
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: id! } }
}

export async function toggleAlertRule(id: string, isActive: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_COMPANY)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('performance_alert_rules').update({ is_active: isActive }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function deleteAlertRule(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_COMPANY)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('performance_alert_rules').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}
