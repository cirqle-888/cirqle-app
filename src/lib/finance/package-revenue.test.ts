import { describe, it, expect } from 'vitest'
import { buildPackageRevenue, type PackageItemInput } from './package-revenue'

const AED = 25.996984

const line = (over: Partial<PackageItemInput> = {}): PackageItemInput => ({
  packageId: 'pkg1',
  packageName: 'Package',
  clientLabel: 'Client',
  billingType: 'monthly',
  packageFeeInr: 10_000,
  serviceId: 'svc1',
  serviceLabel: 'Service',
  departmentId: 'dept1',
  departmentLabel: 'Dept',
  includedQty: 10,
  deliveredQty: 5,
  matrixValueInr: 2_500,
  ...over,
})

describe('buildPackageRevenue — earning a fee', () => {
  it('earns the fee in proportion to delivery and defers the rest', () => {
    const { rows } = buildPackageRevenue([line({ includedQty: 10, deliveredQty: 4, packageFeeInr: 10_000 })])
    expect(rows[0].earnedFeeInr).toBe(4_000)
    expect(rows[0].unearnedFeeInr).toBe(6_000)
    expect(rows[0].completionPct).toBe(40)
    expect(rows[0].remainingQty).toBe(6)
  })

  it('earns the whole fee once the allowance is fully delivered', () => {
    const { rows } = buildPackageRevenue([line({ includedQty: 2, deliveredQty: 2, packageFeeInr: 3_899.55 })])
    expect(rows[0].earnedFeeInr).toBe(3_899.55)
    expect(rows[0].unearnedFeeInr).toBe(0)
  })

  it('CAPS earning at the fee when over-delivered — extras bill separately', () => {
    const { rows } = buildPackageRevenue([line({ includedQty: 10, deliveredQty: 14, packageFeeInr: 10_000 })])
    expect(rows[0].earnedFeeInr).toBe(10_000)
    expect(rows[0].unearnedFeeInr).toBe(0)
    expect(rows[0].extraQty).toBe(4)
    expect(rows[0].remainingQty).toBe(0)
  })

  it('earns nothing when nothing has been delivered', () => {
    const { rows, totalUnearnedFeeInr } = buildPackageRevenue([line({ deliveredQty: 0, matrixValueInr: 0 })])
    expect(rows[0].earnedFeeInr).toBe(0)
    expect(totalUnearnedFeeInr).toBe(10_000)
  })

  it('does not divide by zero on a zero allowance', () => {
    const { rows } = buildPackageRevenue([line({ includedQty: 0, deliveredQty: 0, matrixValueInr: 0 })])
    expect(rows[0].earnedFeeInr).toBe(0)
    expect(rows[0].completionPct).toBe(0)
  })
})

describe('buildPackageRevenue — variance against the price matrix', () => {
  it('reports a positive variance when the package beats the rack rate', () => {
    const { rows } = buildPackageRevenue([
      line({ includedQty: 2, deliveredQty: 2, packageFeeInr: 3_899.55, matrixValueInr: 2_000 }),
    ])
    expect(rows[0].varianceVsMatrixInr).toBe(1_899.55)
  })

  it('reports a negative variance when the package undersells the work', () => {
    const { rows } = buildPackageRevenue([
      line({ includedQty: 2, deliveredQty: 2, packageFeeInr: 1_000, matrixValueInr: 2_000 }),
    ])
    expect(rows[0].varianceVsMatrixInr).toBe(-1_000)
  })
})

describe('buildPackageRevenue — splitting one fee across lines', () => {
  it('weights by observed unit value, not raw quantity', () => {
    // 2 logos worth 1000 each (unit 1000) vs 15 posters worth 100 each (unit 100).
    // Quantity alone would give the posters 15/17 of the fee; by value the
    // allowances are worth 2000 and 1500, so the split is 2000:1500.
    const { rows } = buildPackageRevenue([
      line({ serviceId: 'logo', includedQty: 2, deliveredQty: 2, matrixValueInr: 2_000, packageFeeInr: 7_000 }),
      line({ serviceId: 'poster', includedQty: 15, deliveredQty: 3, matrixValueInr: 300, packageFeeInr: 7_000 }),
    ])
    const logo = rows.find(r => r.serviceId === 'logo')!
    const poster = rows.find(r => r.serviceId === 'poster')!
    expect(logo.feeBasis).toBe('unit_value')
    expect(logo.lineFeeInr).toBe(4_000)      // 2000/3500 × 7000
    expect(poster.lineFeeInr).toBe(3_000)    // 1500/3500 × 7000
  })

  it('falls back to quantity for a line with nothing delivered yet', () => {
    const { rows } = buildPackageRevenue([
      line({ serviceId: 'a', includedQty: 5, deliveredQty: 0, matrixValueInr: 0, packageFeeInr: 1_000 }),
      line({ serviceId: 'b', includedQty: 5, deliveredQty: 0, matrixValueInr: 0, packageFeeInr: 1_000 }),
    ])
    expect(rows.every(r => r.feeBasis === 'quantity')).toBe(true)
    expect(rows[0].lineFeeInr).toBe(500)
    expect(rows[1].lineFeeInr).toBe(500)
  })

  it('keeps each package fee inside its own package', () => {
    const { rows, totalFeeInr } = buildPackageRevenue([
      line({ packageId: 'p1', serviceId: 'a', packageFeeInr: 1_000, includedQty: 1, deliveredQty: 1, matrixValueInr: 100 }),
      line({ packageId: 'p2', serviceId: 'b', packageFeeInr: 4_000, includedQty: 1, deliveredQty: 1, matrixValueInr: 100 }),
    ])
    expect(rows.find(r => r.packageId === 'p1')!.lineFeeInr).toBe(1_000)
    expect(rows.find(r => r.packageId === 'p2')!.lineFeeInr).toBe(4_000)
    expect(totalFeeInr).toBe(5_000)
  })

  it('never allocates more than the fee across many lines', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      line({ serviceId: `s${i}`, packageFeeInr: 1_000, includedQty: 3, deliveredQty: 0, matrixValueInr: 0 }))
    const { totalFeeInr } = buildPackageRevenue(rows)
    expect(totalFeeInr).toBeCloseTo(1_000, 1)
  })
})

describe('buildPackageRevenue — department rollup', () => {
  it('groups lines by department and totals them', () => {
    const { byDepartment, totalEarnedFeeInr, totalUnearnedFeeInr } = buildPackageRevenue([
      line({
        packageId: 'brand', departmentId: 'branding', departmentLabel: 'Branding & Identity',
        serviceId: 'logo', includedQty: 2, deliveredQty: 2,
        packageFeeInr: 150 * AED, matrixValueInr: 2_000,
      }),
      line({
        packageId: 'social', departmentId: 'social', departmentLabel: 'Social Media',
        serviceId: 'poster', includedQty: 15, deliveredQty: 4,
        packageFeeInr: 400 * AED, matrixValueInr: 2_079.76,
      }),
    ])

    const branding = byDepartment.find(d => d.departmentId === 'branding')!
    const social = byDepartment.find(d => d.departmentId === 'social')!

    // Brand Identity: fully delivered, so the whole fee is earned.
    expect(branding.earnedFeeInr).toBeCloseTo(3_899.55, 1)
    expect(branding.unearnedFeeInr).toBe(0)
    expect(branding.varianceVsMatrixInr).toBeCloseTo(1_899.55, 1)

    // Social: 4 of 15 delivered — most of the fee is still owed in work.
    expect(social.earnedFeeInr).toBeCloseTo(2_773.01, 1)
    expect(social.unearnedFeeInr).toBeCloseTo(7_625.78, 1)

    expect(totalEarnedFeeInr).toBeCloseTo(6_672.56, 1)
    expect(totalUnearnedFeeInr).toBeCloseTo(7_625.78, 1)
  })

  it('sorts departments by fee, largest first', () => {
    const { byDepartment } = buildPackageRevenue([
      line({ packageId: 'a', departmentId: 'small', packageFeeInr: 100, serviceId: 'x' }),
      line({ packageId: 'b', departmentId: 'big', packageFeeInr: 9_000, serviceId: 'y' }),
    ])
    expect(byDepartment.map(d => d.departmentId)).toEqual(['big', 'small'])
  })

  it('handles an empty input', () => {
    const p = buildPackageRevenue([])
    expect(p.rows).toEqual([])
    expect(p.byDepartment).toEqual([])
    expect(p.totalFeeInr).toBe(0)
    expect(p.totalVarianceInr).toBe(0)
  })
})
