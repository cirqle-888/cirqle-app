/**
 * Unified Import Pipeline for Advertising ERP
 *
 * Every metric source (Meta API, Google Ads, CSV, Manual Entry) flows through here.
 * Handles merge conflicts (imported vs manual vs locked), currency exchange rate snapshots,
 * event logging, and threshold-based notifications.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { publishAdEvent } from './events'
import { AdDailyMetricRow } from './types'
import { notifyAdmins } from '@/lib/notifications/create'
import { aggregateMetrics } from './reporting'

export interface IngestRow {
  projectId: string
  metricDate: string // YYYY-MM-DD
  spend: number
  revenue: number
  impressions: number
  clicks: number
  reach: number
  leads: number
  adCurrency?: string
}

export interface IngestResult {
  imported: number
  updated: number
  skipped: number
  failed: number
  errors: string[]
}

export async function ingestMetrics(
  source: string,
  employeeId: string | null,
  rows: IngestRow[]
): Promise<IngestResult> {
  const supabase = createAdminClient()
  const result: IngestResult = { imported: 0, updated: 0, skipped: 0, failed: 0, errors: [] }

  if (rows.length === 0) return result

  // 1. Fetch current exchange rates to snapshot them
  const { data: fxData } = await supabase.from('exchange_rates').select('currency, rate_to_inr')
  const fxMap = new Map<string, number>()
  if (fxData) {
    fxData.forEach((f: any) => fxMap.set(f.currency, Number(f.rate_to_inr)))
  }

  // 1.5 Fetch company settings for notifications
  const { data: settingsData } = await supabase.from('company_settings').select('key, value').like('key', 'advertising.%')
  const settings = new Map<string, string>()
  if (settingsData) {
    settingsData.forEach((s: any) => settings.set(s.key, s.value))
  }
  const lowRoasThreshold = Number(settings.get('advertising.notifications.roas_threshold') || 1.0)
  const highCpcThreshold = Number(settings.get('advertising.notifications.cpc_threshold') || 50)

  // 2. Fetch existing metrics for the project(s) and dates
  const projectIds = Array.from(new Set(rows.map(r => r.projectId)))
  const dates = Array.from(new Set(rows.map(r => r.metricDate)))

  const { data: existingData, error: existingErr } = await supabase
    .from('ad_daily_metrics')
    .select('*')
    .in('project_id', projectIds)
    .in('metric_date', dates)

  if (existingErr) {
    throw new Error(`Failed to fetch existing metrics: ${existingErr.message}`)
  }

  const existingMap = new Map<string, AdDailyMetricRow>()
  if (existingData) {
    existingData.forEach((row: any) => existingMap.set(`${row.project_id}_${row.metric_date}`, row))
  }

  // 3. Process each row
  const upsertPayloads: any[] = []

  for (const r of rows) {
    const key = `${r.projectId}_${r.metricDate}`
    const existing = existingMap.get(key)
    
    let isManual = source.toLowerCase() === 'manual'
    let syncState = isManual ? 'manual' : 'imported'
    
    // MERGE LOGIC
    if (existing) {
      if (existing.sync_state === 'locked') {
        if (!isManual) {
          result.skipped++
          continue
        }
      } else if (existing.sync_state === 'manual' && !isManual) {
        result.skipped++
        continue
      }
      result.updated++
    } else {
      result.imported++
    }

    const adCur = r.adCurrency || 'INR'
    const rateToBase = adCur === 'INR' ? 1.0 : (fxMap.get(adCur) || 1.0)
    const rateToBilling = rateToBase 

    upsertPayloads.push({
      ...(existing?.id ? { id: existing.id } : {}),
      project_id: r.projectId,
      metric_date: r.metricDate,
      spend: r.spend,
      revenue: r.revenue,
      impressions: r.impressions,
      clicks: r.clicks,
      reach: r.reach,
      leads: r.leads,
      source,
      sync_state: syncState,
      version: (existing?.version || 0) + 1,
      base_currency: 'INR',
      ad_currency: adCur,
      billing_currency: 'INR',
      exchange_rate_ad_to_base: rateToBase,
      exchange_rate_ad_to_billing: rateToBilling
    })
  }

  // 4. Batch Upsert
  if (upsertPayloads.length > 0) {
    const { error: upsertErr } = await supabase
      .from('ad_daily_metrics')
      .upsert(upsertPayloads, { onConflict: 'project_id,metric_date' })

    if (upsertErr) {
      result.failed = upsertPayloads.length
      result.errors.push(upsertErr.message)
      console.error('[Pipeline] Upsert error:', upsertErr)
      await publishAdEvent('sync_failed', {
        employeeId: employeeId || undefined,
        metadata: { error: upsertErr.message }
      })
      throw new Error(`ad_daily_metrics upsert failed: ${upsertErr.message} (code: ${upsertErr.code})`)
    } else {
      // 5. Fire events and check thresholds
      for (const pid of projectIds) {
        const projectRows = upsertPayloads.filter(p => p.project_id === pid)
        if (projectRows.length === 0) continue

        await publishAdEvent('metrics_imported', {
          projectId: pid,
          employeeId: employeeId || undefined,
          metadata: { source, rows_processed: projectRows.length }
        })

        // Check alerts
        const agg = aggregateMetrics(projectRows)
        
        if (agg.spend > 0 && agg.roas < lowRoasThreshold) {
          await notifyAdmins({
            type: 'low_roas',
            title: 'Low ROAS Alert',
            message: `Campaign (Project ${pid}) ROAS is ${agg.roas.toFixed(2)}, below threshold ${lowRoasThreshold}.`,
            link: `/dashboard/advertising/campaigns/${pid}`,
            sourceKey: `low_roas_${pid}_${new Date().toISOString().slice(0,10)}`
          })
        }

        if (agg.clicks > 0 && agg.cpc > highCpcThreshold) {
          await notifyAdmins({
            type: 'high_cpc',
            title: 'High CPC Alert',
            message: `Campaign (Project ${pid}) CPC is ${agg.cpc.toFixed(2)}, above threshold ${highCpcThreshold}.`,
            link: `/dashboard/advertising/campaigns/${pid}`,
            sourceKey: `high_cpc_${pid}_${new Date().toISOString().slice(0,10)}`
          })
        }
      }
    }
  }

  return result
}
