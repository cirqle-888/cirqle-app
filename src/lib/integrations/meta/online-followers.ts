/**
 * When this client's followers are actually online.
 *
 * Instagram's `online_followers` is the only hourly signal Meta exposes, and
 * it is the one that answers the question this whole feature exists for:
 * what time should this client's post go out?
 *
 * ── Why it is a separate module ─────────────────────────────────────────────
 *
 * insights.ts writes DAILY rows into social_account_insights_daily. This is
 * hourly and it feeds social_best_times, which is evidence rather than
 * reporting — a different table with a different contract. Folding it into
 * the daily sync would put a metric that cannot be stored there inside a
 * function whose whole shape is one row per day.
 *
 * ── What Meta actually returns ──────────────────────────────────────────────
 *
 * `metric=online_followers&period=lifetime` gives one value per DAY, and that
 * value is an object keyed "0".."23" — a count of followers online in each
 * hour, in the account's own timezone. So a 28-day pull is 28 of those
 * objects, and the useful figure is the average per (weekday, hour): a single
 * day tells you about that day's posting, not about Tuesdays.
 *
 * ── The caveat worth knowing ────────────────────────────────────────────────
 *
 * Meta deprecates metrics without much notice, and online_followers has been
 * on and off the list more than once. Every failure here is soft: the caller
 * gets an empty result and the planner falls back to the client's own slots,
 * which were always the authority anyway.
 */
import { metaGraph, redactTokens } from './client'

/** One hour of one weekday, averaged across the window. */
export interface HourlyFollowers {
  /** 0 = Sunday, matching the rest of the posting-time code. */
  weekday: number
  /** 0–23, in the account's own timezone, which is what Meta reports in. */
  hour: number
  /** Mean followers online in that hour. Compared only against other hours. */
  score: number
  /** How many days contributed, so a thin sample can be judged as thin. */
  samples: number
}

export interface OnlineFollowersResult {
  rows: HourlyFollowers[]
  /** Days of data Meta actually returned, before averaging. */
  days: number
  error?: string
}

interface GraphValue { value?: unknown; end_time?: string }
interface GraphMetric { name?: string; values?: GraphValue[] }

/**
 * Average `online_followers` into a weekday × hour grid.
 *
 * Exported and pure so the shaping is testable without a network: the Graph
 * response shape is the part most likely to change under us, and a fixture
 * test is the only honest way to know it still parses.
 */
export function averageByWeekdayHour(values: readonly GraphValue[]): OnlineFollowersResult {
  // [weekday][hour] → running total + count
  const totals = new Map<string, { sum: number; n: number }>()
  let days = 0

  for (const entry of values) {
    const byHour = entry?.value
    if (!byHour || typeof byHour !== 'object' || Array.isArray(byHour)) continue
    // end_time is the START of the day the figures describe, per Meta's own
    // convention of stamping a period with its end. Without it we cannot know
    // which weekday the day was, so the row is unusable rather than guessed.
    if (!entry.end_time) continue
    const at = new Date(entry.end_time)
    if (Number.isNaN(at.getTime())) continue

    const weekday = at.getUTCDay()
    let counted = false
    for (const [rawHour, rawCount] of Object.entries(byHour as Record<string, unknown>)) {
      const hour = Number(rawHour)
      const count = Number(rawCount)
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue
      if (!Number.isFinite(count)) continue
      const key = `${weekday}-${hour}`
      const cell = totals.get(key) ?? { sum: 0, n: 0 }
      cell.sum += count
      cell.n += 1
      totals.set(key, cell)
      counted = true
    }
    if (counted) days++
  }

  const rows: HourlyFollowers[] = []
  for (const [key, cell] of totals) {
    const [weekday, hour] = key.split('-').map(Number)
    rows.push({
      weekday,
      hour,
      // Rounded to one decimal: the raw mean carries false precision, and the
      // numbers are only ever compared with each other.
      score: Math.round((cell.sum / cell.n) * 10) / 10,
      samples: cell.n,
    })
  }
  rows.sort((a, b) => b.score - a.score)
  return { rows, days }
}

/**
 * Pull `online_followers` for one Instagram account.
 *
 * Soft-fails on everything: a deprecated metric, a token problem, an account
 * too small for Meta to report on. The planner's slots are the authority and
 * keep working regardless, so there is nothing here worth breaking a sync for.
 */
export async function fetchOnlineFollowers(
  igUserId: string,
  token: string,
): Promise<OnlineFollowersResult> {
  try {
    const res = await metaGraph<{ data?: GraphMetric[] }>(`${igUserId}/insights`, {
      token,
      params: { metric: 'online_followers', period: 'lifetime' },
    })
    const metric = (res?.data ?? []).find(m => m?.name === 'online_followers') ?? res?.data?.[0]
    const values = metric?.values ?? []
    if (!values.length) return { rows: [], days: 0, error: 'Meta returned no hourly data for this account.' }
    return averageByWeekdayHour(values)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Could not read hourly followers.'
    return { rows: [], days: 0, error: redactTokens(message) }
  }
}
