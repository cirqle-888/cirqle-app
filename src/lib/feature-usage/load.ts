/**
 * Feature Usage — the database reads. Server only (service role); the page and
 * the weekly reminder both call this, then the pure rules in ./report.
 *
 * WHERE USAGE COMES FROM:
 *   1. feature_visits — one row per person per sidebar page per day, written
 *      as people move around the app (POST /api/feature-visit). The real source.
 *   2. item_usage     — pages opened from Quick Actions (⌘K). Existed before
 *      this report, so it gives history from day one, and keeps the report
 *      useful until the feature_visits migration has been run.
 *
 * Deliberately NOT activity_logs: an entity log says what changed, not where.
 * A "client" log is written from Social, Leads, Assets and nine other screens,
 * so mapping it to a feature would mark the wrong pages as used.
 *
 * Names are never read — people are CQIDs.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/supabase/server'
import { addDaysISO, toISODate } from '@/lib/utils/local-date'
import { featureForPath, listFeatures, type Feature } from './catalogue'
import { LOOKBACK_DAYS, type UsageEvent, type UsagePerson } from './report'

export interface FeatureUsageInput {
  features: Feature[]
  people: UsagePerson[]
  events: UsageEvent[]
  /** False until the feature_visits migration has been run. */
  trackingReady: boolean
  /** First day with a page visit inside the lookback (≈ when counting began). */
  trackingSince: string | null
  /** How many usage rows came from each source (for the page's footnote). */
  sources: { visits: number; quickActions: number }
  /** Usage reads that failed; the report still renders from the rest. */
  warnings: string[]
}

const MISSING_TABLE = new Set(['PGRST205', '42P01'])

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v)

export async function loadFeatureUsageInput(admin: SupabaseClient, today: string): Promise<FeatureUsageInput> {
  const features = listFeatures()
  const since = addDaysISO(today, -(LOOKBACK_DAYS - 1))
  const warnings: string[] = []

  // ── People: active staff who can sign in, with their role's permissions ──
  const [empRes, desigRes, dpRes, permRes] = await Promise.all([
    admin.from('employees')
      .select('id, cqid, auth_id, designation_id')
      .eq('is_active', true)
      .eq('is_archived', false),
    admin.from('designations').select('id, name, is_admin'),
    fetchAll(admin.from('designation_permissions')
      .select('designation_id, permission_id, permission:permission_id(key)')
      .eq('allowed', true)
      .order('designation_id')
      .order('permission_id')),
    admin.from('permissions').select('key'),
  ])
  if (empRes.error) throw new Error(`Could not read staff: ${empRes.error.message}`)
  if (desigRes.error) throw new Error(`Could not read designations: ${desigRes.error.message}`)
  if (dpRes.error) throw new Error(`Could not read role permissions: ${dpRes.error.message ?? dpRes.error}`)
  if (permRes.error) throw new Error(`Could not read permissions: ${permRes.error.message}`)

  const allKeys = new Set((permRes.data ?? []).map((p: { key: string }) => p.key))
  const designations = new Map(
    (desigRes.data ?? []).map((d: { id: string; name: string | null; is_admin: boolean | null }) => [d.id, d]),
  )
  const permsByDesignation = new Map<string, Set<string>>()
  for (const r of dpRes.data as { designation_id: string; permission: Joined<{ key: string }> }[]) {
    const key = one(r.permission)?.key
    if (!key) continue
    const set = permsByDesignation.get(r.designation_id) ?? permsByDesignation.set(r.designation_id, new Set()).get(r.designation_id)!
    set.add(key)
  }

  type EmpRow = { id: string; cqid: string | null; auth_id: string | null; designation_id: string | null }
  const people: UsagePerson[] = (empRes.data as EmpRow[])
    // No login = cannot open anything; listing them would only add noise.
    .filter(e => !!e.auth_id && !!e.cqid)
    .map(e => {
      const d = e.designation_id ? designations.get(e.designation_id) : undefined
      const isAdmin = d?.is_admin === true
      return {
        id: e.id,
        cqid: e.cqid!,
        role: d?.name ?? null,
        isAdmin,
        // Same rule as loadCurrentUser: an admin holds every key.
        permissions: isAdmin ? allKeys : (e.designation_id ? permsByDesignation.get(e.designation_id) : undefined) ?? new Set<string>(),
      }
    })

  // ── Usage ────────────────────────────────────────────────────────────────
  const events: UsageEvent[] = []

  // 1. Page visits. Probe first: a missing table is "not set up yet", not an error.
  let trackingReady = true
  let trackingSince: string | null = null
  let visits = 0
  const probe = await admin.from('feature_visits').select('visit_date').limit(1)
  if (probe.error) {
    trackingReady = false
    if (!MISSING_TABLE.has(probe.error.code ?? '')) warnings.push(`page visits: ${probe.error.message}`)
  } else {
    const { data, error } = await fetchAll(admin.from('feature_visits')
      .select('employee_id, feature_href, visit_date')
      .gte('visit_date', since)
      .order('visit_date')
      .order('employee_id')
      .order('feature_href'))
    if (error) warnings.push(`page visits: ${error.message ?? error}`)
    for (const r of data as { employee_id: string; feature_href: string; visit_date: string }[]) {
      events.push({ employeeId: r.employee_id, href: r.feature_href, day: r.visit_date })
      if (!trackingSince || r.visit_date < trackingSince) trackingSince = r.visit_date
      visits++
    }
  }

  // 2. Quick Actions: only its last use per page is kept, so it adds one day each.
  let quickActions = 0
  const qa = await admin.from('item_usage')
    .select('employee_id, href, last_used_at')
    .eq('item_type', 'nav')
    .gte('last_used_at', `${since}T00:00:00+05:30`)
  if (qa.error) {
    if (!MISSING_TABLE.has(qa.error.code ?? '')) warnings.push(`Quick Actions: ${qa.error.message}`)
  } else {
    for (const r of (qa.data ?? []) as { employee_id: string; href: string | null; last_used_at: string | null }[]) {
      const href = r.href ? featureForPath(r.href) : null
      if (!href || !r.last_used_at) continue
      events.push({ employeeId: r.employee_id, href, day: toISODate(new Date(r.last_used_at)) })
      quickActions++
    }
  }

  return { features, people, events, trackingReady, trackingSince, sources: { visits, quickActions }, warnings }
}
