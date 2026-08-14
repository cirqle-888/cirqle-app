/**
 * Performance alert evaluation. Runs in the daily social-sync cron. Reads
 * configurable rules from performance_alert_rules; when a threshold is breached
 * it notifies admins (deduped per client+metric+day via sourceKey). Additive:
 * never throws into the cron.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildAgencyRollups } from './aggregate'
import { notifyAdmins } from '@/lib/notifications/create'
import { todayISO } from '@/lib/utils/local-date'

interface AlertRule { id: string; client_id: string | null; metric: string; threshold: number; is_active: boolean }

export interface AlertEvalResult { evaluated: number; triggered: number }

export async function evaluateMetaAlerts(admin: SupabaseClient, days = 30): Promise<AlertEvalResult> {
  let rules: AlertRule[] = []
  try {
    const { data } = await admin.from('performance_alert_rules').select('*').eq('is_active', true)
    rules = (data ?? []) as AlertRule[]
  } catch {
    return { evaluated: 0, triggered: 0 }
  }
  if (!rules.length) return { evaluated: 0, triggered: 0 }

  const { rollups } = await buildAgencyRollups(admin, days)
  const byClient = new Map(rollups.map((r) => [r.clientId, r]))
  const today = todayISO()

  let triggered = 0
  const fire = async (clientName: string, clientId: string, metric: string, title: string, message: string) => {
    await notifyAdmins({
      type: 'social_sync_failed', // reuse a hub notification type
      title,
      message,
      link: '/dashboard/agency',
      sourceKey: `alert:${metric}:${clientId}:${today}`,
    }).catch(() => {})
    triggered++
  }

  for (const rule of rules) {
    const targets = rule.client_id ? [byClient.get(rule.client_id)].filter(Boolean) : rollups
    for (const r of targets) {
      if (!r) continue
      switch (rule.metric) {
        case 'cpl_above':
          if (r.cpl != null && r.cpl > rule.threshold) await fire(r.clientName, r.clientId, rule.metric, `High CPL · ${r.clientName}`, `Cost per lead ₹${r.cpl} exceeds ₹${rule.threshold}.`)
          break
        case 'leads_drop_pct':
          if (r.leadsDeltaPct != null && r.leadsDeltaPct <= -rule.threshold) await fire(r.clientName, r.clientId, rule.metric, `Leads dropped · ${r.clientName}`, `Leads fell ${Math.abs(r.leadsDeltaPct)}% vs the previous period.`)
          break
        case 'reach_drop_pct':
          if (r.reachDeltaPct != null && r.reachDeltaPct <= -rule.threshold) await fire(r.clientName, r.clientId, rule.metric, `Reach dropped · ${r.clientName}`, `Reach fell ${Math.abs(r.reachDeltaPct)}% vs the previous period.`)
          break
        case 'spend_increase_pct': {
          const delta = r.spendPrev > 0 ? ((r.spend - r.spendPrev) / r.spendPrev) * 100 : (r.spend > 0 ? 100 : 0)
          if (delta >= rule.threshold) await fire(r.clientName, r.clientId, rule.metric, `Ad spend spike · ${r.clientName}`, `Spend rose ${Math.round(delta)}% to ₹${r.spend}.`)
          break
        }
        case 'roas_below':
          if (r.roas != null && r.roas < rule.threshold && r.spend > 0) await fire(r.clientName, r.clientId, rule.metric, `Low ROAS · ${r.clientName}`, `ROAS ${r.roas}× is below ${rule.threshold}×.`)
          break
        case 'ctr_below':
          if (r.ctr != null && r.ctr < rule.threshold && r.spend > 0) await fire(r.clientName, r.clientId, rule.metric, `Low CTR · ${r.clientName}`, `CTR ${r.ctr}% is below ${rule.threshold}%.`)
          break
        case 'stale_sync_hours':
          if (r.syncFailures > 0) await fire(r.clientName, r.clientId, rule.metric, `Accounts not syncing · ${r.clientName}`, `${r.syncFailures} account(s) haven't synced recently.`)
          break
      }
    }
  }

  return { evaluated: rules.length, triggered }
}
