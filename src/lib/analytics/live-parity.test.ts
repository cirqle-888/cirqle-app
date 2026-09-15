import { describe, it, expect } from 'vitest'
import { aggregateByMonth, mergeMonths, type AnalyticsTask } from './historical'
import { aggregateEarnings, dedupeScores, sliceEarnings, type ScoreRow } from './earnings'

/**
 * THE parity test: aggregates against the live database.
 *
 * The unit tests prove the aggregation is self-consistent. Only this proves it
 * says the same thing as the dashboard does today, over the actual data —
 * which is the whole claim a cache rests on. A cache that is fast and quietly
 * 2% low is worse than no cache, because nobody re-adds a dashboard by hand.
 *
 * It needs live credentials, so it SKIPS rather than fails without them: a
 * contributor with no .env still gets a green suite. Run it wherever the
 * service key exists, and in CI before a deploy that touches analytics.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const live = Boolean(url && key)

describe.skipIf(!live)('aggregates match the live dashboard', () => {
  it('reports the same totals the row-by-row path would', async () => {
    const H = { apikey: key!, Authorization: 'Bearer ' + key! }
    const from = new Date(Date.now() - 36 * 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)

    // Exactly the query the dashboard makes today, column list and all.
    const res = await fetch(
      `${url}/rest/v1/tasks?select=billing_amount_inr,task_date,status,is_billable,` +
      `client:clients(id,name),service_id,service:services!service_id(id,name)` +
      `&status=neq.cancelled&deleted_at=is.null&task_date=gte.${from}` +
      `&order=task_date.asc&limit=10000`,
      { headers: H },
    )
    expect(res.ok, 'live query failed').toBe(true)
    const rows = (await res.json()) as AnalyticsTask[]
    if (rows.length === 0) return   // an empty database still passes

    // What the live dashboard computes, straight from the rows.
    const liveValue = rows.reduce((s, t) => s + (Number(t.billing_amount_inr) || 0), 0)
    const liveByClient = new Map<string, number>()
    for (const t of rows) {
      const rev = t.is_billable === false ? 0 : (Number(t.billing_amount_inr) || 0)
      if (t.client?.id) liveByClient.set(t.client.id, (liveByClient.get(t.client.id) || 0) + rev)
    }

    const merged = mergeMonths(aggregateByMonth(rows))

    expect(merged.taskCount).toBe(rows.length)
    expect(merged.taskValue).toBeCloseTo(liveValue, 1)
    for (const [clientId, revenue] of liveByClient) {
      const got = merged.byClient.find(c => c.id === clientId)?.revenue ?? 0
      expect(got, `client ${clientId}`).toBeCloseTo(revenue, 1)
    }

    // And the point of the exercise: the aggregate is a fraction of the size.
    const bytesRows = JSON.stringify(rows).length
    const bytesAgg = JSON.stringify(aggregateByMonth(rows)).length
    expect(bytesAgg, 'aggregate should be much smaller than the rows').toBeLessThan(bytesRows / 2)
  }, 60_000)
})

describe.skipIf(!live)('team earnings match the live dashboard', () => {
  it('reports the same per-employee totals the row-by-row path would', async () => {
    const H = { apikey: key!, Authorization: 'Bearer ' + key! }
    const now = new Date()
    const fromMonth = new Date(now.getFullYear(), now.getMonth() - 35, 1).toISOString().slice(0, 7)
    const curMonth = now.toISOString().slice(0, 7)
    const windowStart = `${fromMonth}-01`
    const cutoff = `${curMonth}-01`

    /** PostgREST caps a page at 1000 rows; the app's fetchAll pages past it. */
    async function all(url: string): Promise<unknown[]> {
      const out: unknown[] = []
      for (let from = 0; ; from += 1000) {
        const r = await fetch(url, { headers: { ...H, Range: `${from}-${from + 999}` } })
        expect(r.ok, `live query failed: ${r.status}`).toBe(true)
        const chunk = (await r.json()) as unknown[]
        out.push(...chunk)
        if (chunk.length < 1000) return out
      }
    }

    // The query the dashboard USED to make, in full.
    const rows = (await all(
      `${url}/rest/v1/contribution_scores?select=employee_id,score_percentage,earnings_inr,` +
      `calculated_at,task:tasks(id,quantity,task_date)` +
      `&calculated_at=gte.${windowStart}&order=calculated_at.desc&order=id.asc`,
    )) as ScoreRow[]
    if (rows.length === 0) return

    // The row-by-row answer, bounded to the same window the new query uses.
    // NOTE the bound: the old query filtered on `calculated_at`, so a
    // recalculation could drag a task from OUTSIDE the 36-month window back in.
    // The aggregate filters on task_date, which is what the window means.
    const direct = new Map<string, { earnings: number; count: number; creatives: number }>()
    for (const s of dedupeScores(rows)) {
      const d = s.task?.task_date
      if (!d || d >= cutoff || d < windowStart) continue
      const e = direct.get(s.employee_id) ?? { earnings: 0, count: 0, creatives: 0 }
      e.earnings += s.earnings_inr || 0
      e.count += 1
      e.creatives += Number(s.task?.quantity ?? 1) * ((s.score_percentage ?? 0) / 100)
      direct.set(s.employee_id, e)
    }

    // The aggregate's answer, from the query the cache actually makes.
    const histRows = (await all(
      `${url}/rest/v1/contribution_scores?select=employee_id,score_percentage,earnings_inr,` +
      `task:tasks!inner(id,quantity,task_date)` +
      `&tasks.task_date=gte.${windowStart}&tasks.task_date=lt.${cutoff}` +
      `&order=calculated_at.desc&order=id.asc`,
    )) as ScoreRow[]
    // The same 62-day tail of per-day detail the page asks for. Passing
    // `windowStart` here would keep a day row for all 36 months — correct, but
    // not what production caches, so not what should be measured.
    const tail = new Date(now)
    tail.setDate(tail.getDate() - 62)
    const agg = aggregateEarnings(histRows, tail.toISOString().slice(0, 10))
    const sliced = sliceEarnings(agg, null)

    expect(sliced.byEmployee.size, 'employee count').toBe(direct.size)
    for (const [id, d] of direct) {
      const got = sliced.byEmployee.get(id)
      expect(got, `employee ${id} missing from the aggregate`).toBeDefined()
      expect(got!.earningsInr, `earnings for ${id}`).toBeCloseTo(d.earnings, 1)
      expect(got!.taskCount, `task count for ${id}`).toBe(d.count)
      expect(got!.creatives, `creatives for ${id}`).toBeCloseTo(d.creatives, 1)
    }

    // And the point of the exercise: what the page holds is a fraction of
    // what it used to fetch on every single load.
    expect(JSON.stringify(agg).length).toBeLessThan(JSON.stringify(rows).length / 10)
  }, 60_000)
})
