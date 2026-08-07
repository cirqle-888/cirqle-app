/**
 * REGRESSION GUARD for the net-salary formula's duplication.
 *
 * `net = base + commission + adjustment − advances − other` is written out
 * independently in four places: the server recalc, the payroll client, the
 * draft cron, and the payslip renderers. That duplication is pre-existing and
 * deliberate (each site needs it in a different shape), but it means a new
 * earnings component can be added to three of them and silently dropped from
 * the fourth — the payslip would then disagree with the stored net, or an
 * employee would be paid an amount their payslip never explains.
 *
 * These tests read the source, because that failure produces no type error and
 * no test failure until real money is wrong.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const NET_SITES = [
  ['server recalc',   'src/app/(dashboard)/dashboard/payroll/actions.ts'],
  ['draft cron',      'src/app/api/cron/payroll-draft/route.ts'],
  ['payslip (html)',  'src/lib/payslip/payslip-html.ts'],
  ['payslip (pdf)',   'src/lib/payslip/payslip-pdf.ts'],
] as const

describe('every net-salary site includes every earnings component', () => {
  // Each site names components in its own idiom (snake_case DB column vs
  // camelCase view model), so match either spelling.
  it.each(NET_SITES)('%s carries the prior-period adjustment', (_label, file) => {
    expect(read(file)).toMatch(/adjustment_earned|adjustmentEarned|\badjustment\b/)
  })

  it.each(NET_SITES)('%s carries the ownership reward', (_label, file) => {
    expect(read(file)).toMatch(/ownership_earned|ownershipEarned|\bownership\b/)
  })

  it('the payslip renderers add BOTH into GROSS, not just print them', () => {
    // A line item that is displayed but excluded from the gross total is worse
    // than no line at all: the payslip would visibly fail to add up.
    for (const file of ['src/lib/payslip/payslip-html.ts', 'src/lib/payslip/payslip-pdf.ts']) {
      const grossLine = read(file).split('\n').find(l => /const gross\s*=/.test(l))
      expect(grossLine, `${file} must compute a gross`).toBeDefined()
      expect(grossLine!).toMatch(/adjustment/)
      expect(grossLine!).toMatch(/ownership/)
    }
  })

  it('a failed ownership computation keeps stored values instead of zeroing pay', () => {
    // The null-vs-empty distinction is load-bearing: treating "could not
    // compute" as "computed as zero" would wipe a real reward on a transient
    // read failure, and the recalc would then persist that zero.
    const src = read('src/app/(dashboard)/dashboard/payroll/actions.ts')
    expect(src).toMatch(/ownershipByEmployee\s*\n?\s*\?[\s\S]{0,120}:\s*oldOwnership/)
  })

  it('the draft cron drafts salary-only and adjustment-only employees', () => {
    // The original filter was `commission > 0`, which silently excluded every
    // support employee paid a fixed salary and no task commission — they never
    // appeared in payroll at all.
    const src = read('src/app/api/cron/payroll-draft/route.ts')
    // Code only — the docblock above the filter also mentions `commission > 0`
    // while explaining why that test alone was wrong.
    const filterLine = src.split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .find(l => l.includes('commission > 0'))
    expect(filterLine, 'draft filter should still gate on some component').toBeDefined()
    expect(filterLine!).toMatch(/baseSalary\s*>\s*0|adjustment/)
  })
})

describe('adjustments never rewrite a closed month', () => {
  it('recordAdjustments only writes once the source month is finalized', () => {
    const src = read('src/lib/payroll/adjustments.ts')
    const fnAt = src.indexOf('export async function recordAdjustments')
    expect(fnAt).toBeGreaterThan(-1)
    const body = src.slice(fnAt)

    // The guard is INVERTED relative to every other money writer, and that is
    // the point: an OPEN month needs no adjustment ledger (recalculating its
    // payroll picks the change up directly), so writing one as well would pay
    // the same rupees twice.
    const guard = body.search(/if\s*\(!\(await isMonthFinalized\(/)
    expect(guard).toBeGreaterThan(-1)

    const write = body.search(/\.(update|upsert|insert)\(/)
    expect(write).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(write)
  })

  it('settlement can only ever consume an unsettled row', () => {
    // Settled rows are history. The filter is what stops a re-run from paying
    // the same adjustment into a second payslip.
    const src = read('src/lib/payroll/adjustments.ts')
    const fnAt = src.indexOf('export async function settleAdjustments')
    expect(fnAt).toBeGreaterThan(-1)
    const body = src.slice(fnAt)
    expect(body).toMatch(/\.is\('settled_at', null\)/)
  })
})
