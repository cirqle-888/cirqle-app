/**
 * Feature Usage — the pure rules. No database, no clock: the caller passes the
 * people, the usage events and today's date, and gets the report back. That is
 * what makes "used rarely" and "never opened" testable (report.test.ts).
 *
 * THE RULES, in the words the page uses:
 *   · Never used  — nobody (or this person) opened it in the last 90 days.
 *   · Used rarely — opened, but less often than it is meant to be.
 *   · Used well   — opened at least as often as it is meant to be:
 *                     daily tool    on 12+ days of the last 30,
 *                     weekly tool   on 4+ days of the last 30,
 *                     monthly tool  at least once in the last 30 days,
 *                     set-up tool   at least once in the last 90 days.
 *   A "day" is a day on which anyone in scope opened it, so ten people opening
 *   it on the same morning is one day, not ten.
 *
 * People are identified by CQID only.
 */
import { isNavItemVisible, type NavItem } from '@/lib/nav-sections'
import type { UnitLock } from '@/lib/units/access'
import { addDaysISO } from '@/lib/utils/local-date'
import type { Feature, Rhythm } from './catalogue'

/** "Recently" — the window for rare vs well. */
export const RECENT_DAYS = 30
/** How far back the report looks at all. Older use counts as never. */
export const LOOKBACK_DAYS = 90

/** Days in the last 30 a feature of this rhythm needs to count as used well. */
export const WELL_DAYS: Record<Rhythm, number> = { daily: 12, weekly: 4, monthly: 1, occasional: 0 }

export type UsageStatus = 'never' | 'rare' | 'well'

export interface UsagePerson {
  id: string
  cqid: string
  /** Designation name, e.g. "Designer" (a role, never a person's name). */
  role: string | null
  isAdmin: boolean
  permissions: ReadonlySet<string>
  /**
   * On a unit's team (Departments & Brands): only the unit-team pages, or with
   * 'staff' the shorter staff list — whatever their role allows elsewhere.
   */
  unitLock?: UnitLock
}

/** "This person opened this feature on this day." */
export interface UsageEvent {
  employeeId: string
  /** A feature href (already mapped from the page path). */
  href: string
  /** YYYY-MM-DD on the business calendar. */
  day: string
}

export interface FeatureUsageRow extends Feature {
  status: UsageStatus
  /** Last day anyone in scope opened it, within the lookback. */
  lastUsed: string | null
  /** Distinct days in the last 30 on which anyone in scope opened it. */
  activeDays30: number
  /** CQIDs who opened it in the last 30 days. */
  usedBy30: string[]
  /** CQIDs whose role lets them open it. */
  allowed: string[]
  /** Allowed, but not opened in the lookback. */
  notYetBy: string[]
}

export interface PersonUsage {
  id: string
  cqid: string
  role: string | null
  isAdmin: boolean
  allowedCount: number
  usedCount: number
  /** Last day they opened any feature, within the lookback. */
  lastActive: string | null
  /** Hrefs their role allows that they have not opened in the lookback, sidebar order. */
  neverOpened: string[]
}

export interface FeatureUsageReport {
  today: string
  /** Rows for the features in scope, sidebar order. */
  rows: FeatureUsageRow[]
  counts: Record<UsageStatus, number>
  /** One line per person (everyone, even when the rows are for one person). */
  people: PersonUsage[]
  /** Set when the rows are for one person. */
  person: PersonUsage | null
}

/** May this person open this feature? The sidebar's own rule. */
export function canUseFeature(feature: Feature, person: UsagePerson): boolean {
  // isNavItemVisible reads only the gate fields; the icon never matters here.
  const item = {
    label: feature.label,
    href: feature.href,
    requiredPerm: feature.requiredPerm,
    requiredAnyPerm: feature.requiredAnyPerm,
    adminOnly: feature.adminOnly,
    unitTeams: feature.unitTeams,
  } as NavItem
  // An admin holds every key (loadCurrentUser gives them all), so they pass
  // even when a key is missing from the permissions table. A unit team gets
  // only its unit pages, so the rest are never "unused" for them.
  return isNavItemVisible(item, k => person.isAdmin || person.permissions.has(k), person.isAdmin, person.unitLock ?? false)
}

/** Never / rare / well for one feature, from how many recent days it was used. */
export function classifyUsage(rhythm: Rhythm, activeDays30: number, usedInLookback: boolean): UsageStatus {
  if (!usedInLookback) return 'never'
  return activeDays30 >= WELL_DAYS[rhythm] ? 'well' : 'rare'
}

const byCqid = (a: { cqid: string }, b: { cqid: string }) =>
  a.cqid.localeCompare(b.cqid, undefined, { numeric: true })

export function buildFeatureUsage(input: {
  features: Feature[]
  people: UsagePerson[]
  events: UsageEvent[]
  today: string
  /** Limit the rows to one person: their usage, and only the features their role allows. */
  personId?: string | null
}): FeatureUsageReport {
  const { features, today } = input
  const people = [...input.people].sort(byCqid)
  const recentFrom = addDaysISO(today, -(RECENT_DAYS - 1))
  const lookbackFrom = addDaysISO(today, -(LOOKBACK_DAYS - 1))
  const known = new Set(features.map(f => f.href))
  const personIds = new Set(people.map(p => p.id))

  // feature href → person id → days used. Only people in the list (active staff
  // with a login), only known features, only days inside the lookback.
  const used = new Map<string, Map<string, Set<string>>>()
  for (const e of input.events) {
    if (!known.has(e.href) || !personIds.has(e.employeeId)) continue
    if (e.day < lookbackFrom || e.day > today) continue
    const perPerson = used.get(e.href) ?? used.set(e.href, new Map()).get(e.href)!
    const days = perPerson.get(e.employeeId) ?? perPerson.set(e.employeeId, new Set()).get(e.employeeId)!
    days.add(e.day)
  }

  const allowedBy = new Map<string, UsagePerson[]>(
    features.map(f => [f.href, people.filter(p => canUseFeature(f, p))]),
  )

  const summaries: PersonUsage[] = people.map(p => {
    const allowed = features.filter(f => allowedBy.get(f.href)!.includes(p))
    let lastActive: string | null = null
    const neverOpened: string[] = []
    let usedCount = 0
    for (const f of allowed) {
      const days = used.get(f.href)?.get(p.id)
      if (!days?.size) { neverOpened.push(f.href); continue }
      usedCount++
      for (const d of days) if (!lastActive || d > lastActive) lastActive = d
    }
    return {
      id: p.id, cqid: p.cqid, role: p.role, isAdmin: p.isAdmin,
      allowedCount: allowed.length, usedCount, lastActive, neverOpened,
    }
  })

  const person = input.personId ? summaries.find(s => s.id === input.personId) ?? null : null
  const scope = person ? people.filter(p => p.id === person.id) : people
  const scopeIds = new Set(scope.map(p => p.id))
  const inScope = person
    ? features.filter(f => allowedBy.get(f.href)!.some(p => p.id === person.id))
    : features

  const rows: FeatureUsageRow[] = inScope.map(f => {
    const perPerson = used.get(f.href) ?? new Map<string, Set<string>>()
    const recentDays = new Set<string>()
    const usedBy30: string[] = []
    let lastUsed: string | null = null
    let usedAtAll = false
    for (const p of scope) {
      const days = perPerson.get(p.id)
      if (!days?.size) continue
      usedAtAll = true
      let recent = false
      for (const d of days) {
        if (!lastUsed || d > lastUsed) lastUsed = d
        if (d >= recentFrom) { recentDays.add(d); recent = true }
      }
      if (recent) usedBy30.push(p.cqid)
    }
    const allowed = allowedBy.get(f.href)!.filter(p => scopeIds.has(p.id))
    return {
      ...f,
      status: classifyUsage(f.rhythm, recentDays.size, usedAtAll),
      lastUsed,
      activeDays30: recentDays.size,
      usedBy30,
      allowed: allowed.map(p => p.cqid),
      notYetBy: allowed.filter(p => !perPerson.get(p.id)?.size).map(p => p.cqid),
    }
  })

  const counts: Record<UsageStatus, number> = { never: 0, rare: 0, well: 0 }
  for (const r of rows) counts[r.status]++
  return { today, rows, counts, people: summaries, person }
}

/** Whole weeks since 1970-01-05 (a Monday), so every Monday moves the reminder on by one. */
export function weekNumber(dayISO: string): number {
  const [y, m, d] = dayISO.split('-').map(Number)
  const days = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1970, 0, 5)) / 86_400_000)
  return Math.floor(days / 7)
}

/**
 * A few features for the weekly reminder: never-used ones first, then rarely
 * used. Rotates by week so the same three do not come back every Monday.
 * The report page itself is never suggested.
 */
export function pickReminderFeatures(
  rows: FeatureUsageRow[], today: string, n = 3, selfHref = '/dashboard/reports/feature-usage',
): FeatureUsageRow[] {
  const pool = (status: UsageStatus) => rows.filter(r => r.status === status && r.href !== selfHref && r.allowed.length > 0)
  const candidates = pool('never').length ? pool('never') : pool('rare')
  if (!candidates.length) return []
  const take = Math.min(n, candidates.length)
  const start = (weekNumber(today) * take) % candidates.length
  return Array.from({ length: take }, (_, i) => candidates[(start + i) % candidates.length])
}

/** The weekly in-app reminder's words, or null when there is nothing to suggest. */
export function reminderText(picked: FeatureUsageRow[]): { title: string; message: string } | null {
  if (!picked.length) return null
  const never = picked.every(p => p.status === 'never')
  const n = picked.length
  const title = never
    ? `${n} feature${n === 1 ? '' : 's'} nobody has used yet`
    : `${n} feature${n === 1 ? '' : 's'} hardly used this month`
  const message = picked.map(p => `${p.label}: ${p.start}`).join(' · ')
  return { title, message: message.length > 600 ? `${message.slice(0, 597)}…` : message }
}
