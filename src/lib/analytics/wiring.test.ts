import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The wiring, held in place by reading the source.
 *
 * A cache with correct invalidation LOGIC and a write path that never calls it
 * is indistinguishable from having no invalidation at all — and it fails
 * silently, showing a confidently wrong number for up to 24 hours. The unit
 * tests next door prove `invalidateAnalyticsForDate` decides correctly; these
 * prove somebody actually asks it.
 *
 * Source-reading tests are the pattern this repo already uses for exactly this
 * class of promise — see `round2.test.ts` and `payroll/historical-contract.test.ts`.
 * They rot loudly, which is the point.
 */

const root = join(__dirname, '../../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const ACTIONS = 'src/app/(dashboard)/dashboard/tasks/actions.ts'

/** Pull one exported function's body out of the actions file. */
function body(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`)
  expect(start, `${name} no longer exists in ${ACTIONS}`).toBeGreaterThan(-1)
  const next = src.slice(start + 1).search(/^export (async )?function |^export interface /m)
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next)
}

describe('every task write that can change a closed month clears its cache', () => {
  const src = read(ACTIONS)

  // Each of these changes something `aggregateByMonth` sums: the value, the
  // creative count, the billable flag, or whether the row is counted at all.
  const mustBust = [
    'serverDeleteTask',
    'serverRestoreTask',
    'serverPermanentDeleteTask',
    'serverEmptyTrash',
    'serverUpdateTaskStatus',
    'serverBulkUpdateStatus',
    'serverBulkDeleteTasks',
    'serverCancelTask',
    'serverFillTaskBilling',
    'serverInlineTaskUpdate',
    'serverSaveTask',
    'serverSetDerivedOverride',
  ]

  it.each(mustBust)('%s busts the analytics cache', name => {
    expect(body(src, name)).toMatch(/bustAnalytics(ForTasks)?\(/)
  })

  it('reads a permanently deleted task\'s date BEFORE deleting it', () => {
    // Afterwards there is no row, and no way to know which month to clear.
    const fn = body(src, 'serverPermanentDeleteTask')
    expect(fn.indexOf('readTaskScope')).toBeLessThan(fn.indexOf(".delete()"))
  })

  it('clears the month a task LEFT as well as the one it joined', () => {
    // Two actions can move a task's date. Both must pass the old date too, or
    // the month it left keeps counting money that is no longer there.
    for (const name of ['serverSaveTask', 'serverInlineTaskUpdate']) {
      expect(body(src, name), name).toMatch(/bustAnalytics\(\s*scope(Before)?\??\.?\w*,/)
    }
  })
})

describe('browser writers go through the server action', () => {
  it('a task created in the browser reports its date back', () => {
    // `tasks-client.tsx` inserts straight into Supabase; `revalidateTag` does
    // not exist there, so a back-dated task can only reach the cache this way.
    const src = read('src/app/(dashboard)/dashboard/tasks/tasks-client.tsx')
    expect(src).toContain('notifyAnalyticsChanged')
  })

  it('a bulk import clears everything, since it can span any months', () => {
    const src = read('src/app/(dashboard)/dashboard/import/import-client.tsx')
    expect(src).toContain('notifyAnalyticsBulkChange')
  })

  it('the server action refuses an anonymous caller', () => {
    // It forces database reads. Unauthenticated, it is a way to run up the
    // egress bill this whole cache exists to reduce.
    const src = read('src/app/(dashboard)/dashboard/analytics-actions.ts')
    expect(src).toContain('loadCurrentUser')
  })
})

describe('team earnings are cached safely', () => {
  const page = read('src/app/(dashboard)/dashboard/page.tsx')
  const cache = read('src/lib/analytics/cache.ts')

  it('ONLY the admin branch uses the shared cache', () => {
    // `unstable_cache` has no user in its key. Caching the employee branch —
    // which is scoped to one `employee_id` — would serve one person's earnings
    // to the next caller whose key happened to match.
    // The call site, not the import — the import has no paren after it.
    const call = page.indexOf('getHistoricalEarnings(')
    expect(call).toBeGreaterThan(-1)
    const guard = page.lastIndexOf('isAdmin', call)
    expect(guard, 'getHistoricalEarnings must sit inside an isAdmin branch').toBeGreaterThan(-1)
    // …and the employee branch must still filter by employee_id.
    expect(page).toMatch(/\.eq\('employee_id', employeeId\)/)
  })

  it('the cached read filters by TASK date, never by calculated_at', () => {
    // `calculated_at` records when the sum ran. Filtering on it puts a
    // September recalculation of a March task into September.
    const fn = cache.slice(cache.indexOf('export async function loadHistoricalEarnings'))
    expect(fn).toMatch(/tasks\.task_date/)
    expect(fn).not.toMatch(/\.gte\('calculated_at'/)
  })

  it('the cached read asks for newest-first, which dedupe depends on', () => {
    // `dedupeScores` keeps the FIRST row per (employee, task). If the order
    // were ascending it would keep the oldest calculation and be wrong with
    // no visible symptom.
    const fn = cache.slice(cache.indexOf('export async function loadHistoricalEarnings'))
    expect(fn).toMatch(/\.order\('calculated_at', \{ ascending: false \}\)/)
  })

  it('a contribution recalculation clears the months it rewrote', () => {
    const route = read('src/app/api/recalc-commissions/route.ts')
    expect(route).toContain('invalidateAnalyticsForDates')
    // …but never a finalized month: those were not recomputed either.
    expect(route).toMatch(/filter\(k => !finalized\.has\(k\)\)/)
  })

  it('saving a contribution split clears that task\'s month', () => {
    const actions = read('src/app/(dashboard)/dashboard/contributions/actions.ts')
    expect(actions).toMatch(/invalidateAnalyticsForDates\(\[task\.task_date\]\)/)
  })
})

describe('the dashboard reads aggregates, not three years of rows', () => {
  const client = read('src/app/(dashboard)/dashboard/dashboard-analytics.tsx')
  const page = read('src/app/(dashboard)/dashboard/page.tsx')

  it('no consumer walks a 36-month task array any more', () => {
    // The regression this guards: someone adds a metric, cannot find it on the
    // view, and re-adds the full task query "just for this one chart".
    expect(client).not.toContain('allAnalyticsTasks')
  })

  it('the page still queries the CURRENT month live', () => {
    // Cached history is only acceptable because today is never cached.
    expect(page).toMatch(/getHistoricalAnalytics/)
    expect(page).toMatch(/buildView/)
  })

  it('the task aggregate carries no employee identity', () => {
    // Privacy survives because there is nobody in the cached shape to leak.
    const hist = read('src/lib/analytics/historical.ts')
    expect(hist).not.toMatch(/employee_id|employeeName|\bcqid\b/)
  })

  it('the earnings aggregate carries ids but never a NAME', () => {
    // It cannot avoid employee ids — it is per-employee by definition. It can
    // and must avoid names, which is what `npm run lint:privacy` enforces.
    const earn = read('src/lib/analytics/earnings.ts')
    expect(earn).not.toMatch(/employeeName|\bcqid\b|employees\(name/)
  })

  it('team earnings no longer walk raw score rows in the browser', () => {
    expect(client).not.toMatch(/scoresPromise/)
    expect(client).toContain('sliceEarnings')
  })
})
