import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Every cron route must authenticate.
 *
 * These endpoints run as the service role and do real work — drafting payroll,
 * publishing social posts, refreshing OAuth tokens, deleting old reports. They
 * are plain HTTP GETs on a public domain, so the ONLY thing between the open
 * internet and a payroll draft is the Bearer check against CRON_SECRET.
 *
 * The check must also fail closed. `authHeader !== \`Bearer ${undefined}\`` is
 * true for a missing secret, but a route that tested only the header and not the
 * secret's presence would authorise anyone sending the literal string
 * "Bearer undefined" if CRON_SECRET were ever unset in an environment.
 *
 * Adding a cron route without this guard should fail here, not in production.
 */
const CRON_DIR = join(process.cwd(), 'src/app/api/cron')

describe('cron route authentication', () => {
  const routes = readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  it('finds the cron routes', () => {
    expect(routes.length).toBeGreaterThan(0)
  })

  it.each(routes)('%s checks CRON_SECRET and fails closed', (name) => {
    const file = join(CRON_DIR, name, 'route.ts')
    expect(existsSync(file), `${name} has no route.ts`).toBe(true)
    const src = readFileSync(file, 'utf8')

    expect(src, `${name} does not reference CRON_SECRET`).toContain('CRON_SECRET')

    // Two idioms are in use and both are correct, so assert the behaviour
    // rather than a spelling:
    //
    //   inline:  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${...}`)
    //   helper:  const token = process.env.CRON_SECRET
    //            if (!token) return false   // fail closed
    //
    // What must hold either way is that the secret's own emptiness is tested.
    // Without it, an environment missing CRON_SECRET would accept the literal
    // header "Bearer undefined" from anyone.
    const assignedTo = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.CRON_SECRET/.exec(src)
    const guardsInline = /!\s*process\.env\.CRON_SECRET/.test(src)
    const guardsVariable = assignedTo
      ? new RegExp(`!\\s*${assignedTo[1]}\\b`).test(src)
      : false
    expect(
      guardsInline || guardsVariable,
      `${name} must reject when CRON_SECRET is unset, not only when the header differs`,
    ).toBe(true)
    expect(
      /401/.test(src),
      `${name} must answer 401 when the bearer token does not match`,
    ).toBe(true)
  })

  it('every scheduled path in vercel.json has a route handler', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'))
    const scheduled: string[] = (vercel.crons ?? []).map((c: { path: string }) => c.path)
    const missing = scheduled.filter(
      (p) => !existsSync(join(process.cwd(), 'src/app', p, 'route.ts')),
    )
    expect(missing, `Scheduled in vercel.json but no handler:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('every cron route is actually scheduled', () => {
    const vercel = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'))
    const scheduled = new Set<string>((vercel.crons ?? []).map((c: { path: string }) => c.path))
    const unscheduled = routes.filter((r) => !scheduled.has(`/api/cron/${r}`))
    expect(
      unscheduled,
      `These routes exist but nothing runs them — dead code, or a missing entry\n` +
        `in vercel.json:\n  ${unscheduled.join('\n  ')}`,
    ).toEqual([])
  })
})
