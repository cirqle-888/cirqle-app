import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Liveness and readiness for uptime monitoring.
 *
 * There was no health endpoint and no error tracking, so the only signal that
 * production was broken was somebody noticing. The 2026-08-29 audit found a
 * PGRST201 fault that ran for nine minutes across two users and was visible
 * only in Vercel's runtime logs afterwards.
 *
 * Deliberately public — an uptime monitor cannot hold a session — so the body
 * is coarse by design: booleans and a duration, never a driver message, a table
 * name, a row count or a version. `checks.database` distinguishes "the app is
 * up" from "the app can reach its data", which is the distinction that matters
 * when Supabase is throttled or over quota.
 *
 * Cheap on purpose: `head: true` with `count: 'exact'` on a tiny table sends no
 * rows back, and `permissions` is a small static catalogue, so this costs a
 * round-trip rather than egress. It is safe to poll every 30s.
 *
 * 200 when everything passes, 503 otherwise, so a monitor can alert on status
 * alone without parsing the body.
 */

const TIMEOUT_MS = 5_000

export async function GET() {
  const startedAt = Date.now()

  const config =
    Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
    Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)

  let database = false
  let databaseMs: number | null = null

  if (config) {
    const t0 = Date.now()
    try {
      // Never let a hung connection hold the request open — a health check that
      // hangs reads as a timeout to the monitor, which is indistinguishable from
      // the app being down and tells you less than an explicit false.
      const probe = createAdminClient()
        .from('permissions')
        .select('*', { head: true, count: 'exact' })
        .limit(1)

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS),
      )

      const { error } = (await Promise.race([probe, timeout])) as { error: unknown }
      database = !error
    } catch {
      database = false
    }
    databaseMs = Date.now() - t0
  }

  const ok = config && database

  return NextResponse.json(
    {
      ok,
      checks: { config, database },
      databaseMs,
      uptimeMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: {
        // Must never be cached: a cached 200 outlives the outage it is meant
        // to report.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    },
  )
}
