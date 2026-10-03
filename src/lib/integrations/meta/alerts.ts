/**
 * Performance alert evaluation. Runs in the daily social-sync cron. Reads
 * configurable rules from performance_alert_rules; when a threshold is breached
 * it notifies admins. Additive: never throws into the cron.
 *
 * ONE ALERT PER EPISODE, NOT PER DAY. The sourceKey only dedupes within a day,
 * so a drop that lasted a week used to alert every single day — "Reach dropped ·
 * Elara Luxe Perfume" was 12 of the owner's last 22 notifications. Now a
 * client+metric that already alerted within REALERT_DAYS stays quiet; if the
 * condition is still true after that, it reminds once more.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildAgencyRollups } from './aggregate'
import { notifyAdmins } from '@/lib/notifications/create'
import { todayISO } from '@/lib/utils/local-date'

/** While a breach persists, remind at most this often. */
export const REALERT_DAYS = 7

/** `alert:<metric>:<clientId>:<YYYY-MM-DD>` → `<metric>:<clientId>`, or null for other keys. */
export function alertEpisodeOf(sourceKey: string | null | undefined): string | null {
  const m = /^alert:([^:]+):(.+):\d{4}-\d{2}-\d{2}$/.exec(sourceKey ?? '')
  return m ? `${m[1]}:${m[2]}` : null
}

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

  // Episodes already alerted recently. Read by source_key, not type, so alerts
  // sent under the old borrowed type still count and nothing re-fires on the
  // first run after this change.
  const recent = new Set<string>()
  try {
    const since = new Date(Date.now() - REALERT_DAYS * 86_400_000).toISOString()
    const { data } = await admin
      .from('notifications')
      .select('source_key')
      .like('source_key', 'alert:%')
      .gte('created_at', since)
    for (const row of (data ?? []) as { source_key: string | null }[]) {
      const ep = alertEpisodeOf(row.source_key)
      if (ep) recent.add(ep)
    }
  } catch { /* fall back to per-day dedupe only */ }

  let triggered = 0
  const fire = async (clientName: string, clientId: string, metric: string, title: string, message: string) => {
    const episode = `${metric}:${clientId}`
    if (recent.has(episode)) return
    recent.add(episode)
    await notifyAdmins({
      // Its own type — this used to borrow 'social_sync_failed', which filed a
      // performance dip under "sync failed".
      type: 'performance_alert',
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
