/**
 * Finance Engine — packaged work: fee earned vs matrix value (pure).
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 *
 * Department revenue elsewhere in this engine is Σ `tasks.billing_amount_inr` —
 * the PRICE-MATRIX value of each task. That is right for ordinary work, and
 * wrong for work sold inside a package, because the client never agreed to pay
 * per task. They agreed to pay a fee.
 *
 * Two different numbers therefore exist for the same delivered work:
 *
 *   MATRIX VALUE — Σ billing_amount_inr on the covered tasks. What a per-task
 *                  report counts. Useful as a yardstick for what the work would
 *                  have fetched on its own.
 *   FEE EARNED   — the share of the package fee that delivery has worked off,
 *                  `fee × delivered ÷ included`. What the business actually
 *                  earned.
 *
 * Their difference is not an error to hide; it says whether a package is priced
 * above or below the rack rate for what it is consuming.
 *
 * ── The balance ──────────────────────────────────────────────────────────────
 *
 * `unearnedFeeInr` is the fee taken for work NOT yet delivered — deferred
 * revenue, and an obligation. A package billed AED 400 for 15 posters with 4
 * delivered is not 400 of revenue; it is 106.67 earned and 293.33 owed in work.
 * Reporting the whole fee as revenue on the invoice date would flatter every
 * month a retainer is signed and starve every month it is worked off.
 *
 * ── Splitting a fee across several included lines ────────────────────────────
 *
 * One fee, several services, so it must be apportioned. Weighting by included
 * QUANTITY alone would value a logo the same as a poster. So the split is by
 * `includedQty × observed unit matrix value` wherever a unit value can be seen
 * in the delivered tasks, falling back to quantity only when nothing has been
 * delivered yet for that line. `feeBasis` records which was used, because an
 * apportionment whose basis is invisible is an apportionment nobody can check.
 *
 * Every figure here is derived; nothing is written back to a task or a package.
 */

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
const pct1 = (v: number) => Math.round(v * 1000) / 10

export type PackageBasis = 'unit_value' | 'quantity'

/** One included line of a package, with what has been delivered against it. */
export interface PackageItemInput {
  packageId: string
  packageName: string
  clientLabel: string
  billingType: 'one_time' | 'monthly'
  /**
   * The WHOLE package's fee in INR for the window being reported. The caller
   * resolves cycles (an extended opening cycle bills once) before passing it;
   * this module never re-derives a billing calendar.
   */
  packageFeeInr: number
  serviceId: string
  serviceLabel: string
  departmentId: string
  departmentLabel: string
  includedQty: number
  deliveredQty: number
  /** Σ billing_amount_inr of the delivered tasks on this line. */
  matrixValueInr: number
}

export interface PackageRevenueRow extends PackageItemInput {
  /** Fee apportioned to this line. */
  lineFeeInr: number
  feeBasis: PackageBasis
  /** Never negative — over-delivery is reported via `extraQty`. */
  remainingQty: number
  extraQty: number
  /** lineFee × min(1, delivered ÷ included). Capped: over-delivery earns no more fee. */
  earnedFeeInr: number
  /** lineFee − earnedFee. Paid for, not yet delivered. */
  unearnedFeeInr: number
  /** earnedFee − matrixValue. Positive = the package beats the rack rate. */
  varianceVsMatrixInr: number
  completionPct: number
}

export interface PackageDepartmentTotal {
  departmentId: string
  departmentLabel: string
  feeInr: number
  earnedFeeInr: number
  unearnedFeeInr: number
  matrixValueInr: number
  varianceVsMatrixInr: number
}

export interface PackageRevenue {
  rows: PackageRevenueRow[]
  byDepartment: PackageDepartmentTotal[]
  totalFeeInr: number
  totalEarnedFeeInr: number
  totalUnearnedFeeInr: number
  totalMatrixValueInr: number
  /** totalEarned − totalMatrix: how much a per-task report mis-states packaged work. */
  totalVarianceInr: number
}

/**
 * Build the packaged-work view.
 *
 * Items of the same `packageId` share one fee; pass every line of a package
 * together or its fee will be apportioned against an incomplete set.
 */
export function buildPackageRevenue(items: PackageItemInput[]): PackageRevenue {
  // Group by package so one fee is split across exactly its own lines.
  const byPackage = new Map<string, PackageItemInput[]>()
  for (const i of items) {
    const arr = byPackage.get(i.packageId)
    if (arr) arr.push(i)
    else byPackage.set(i.packageId, [i])
  }

  const rows: PackageRevenueRow[] = []

  for (const lines of byPackage.values()) {
    // Weight each line by what its included allowance is worth, using the unit
    // value the delivered tasks actually show. A line with nothing delivered
    // has no observable unit value and falls back to quantity.
    const weights = lines.map(l => {
      const unit = l.deliveredQty > 0 ? l.matrixValueInr / l.deliveredQty : null
      const basis: PackageBasis = unit != null && unit > 0 ? 'unit_value' : 'quantity'
      const weight = basis === 'unit_value'
        ? Math.max(0, l.includedQty) * unit!
        : Math.max(0, l.includedQty)
      return { basis, weight }
    })
    const totalWeight = weights.reduce((s, w) => s + w.weight, 0)
    const fee = lines[0]?.packageFeeInr ?? 0

    lines.forEach((l, idx) => {
      const share = totalWeight > 0 ? weights[idx].weight / totalWeight : (1 / lines.length)
      const lineFeeInr = r2(fee * share)

      const included = Math.max(0, l.includedQty)
      const delivered = Math.max(0, l.deliveredQty)
      // Over-delivery does not earn extra fee — extras bill separately, which is
      // the whole point of an overage rate. Capping here stops a package that
      // ran long from silently recognising more revenue than was ever charged.
      const completion = included > 0 ? Math.min(1, delivered / included) : (delivered > 0 ? 1 : 0)
      const earnedFeeInr = r2(lineFeeInr * completion)

      rows.push({
        ...l,
        lineFeeInr,
        feeBasis: weights[idx].basis,
        remainingQty: Math.max(0, included - delivered),
        extraQty: Math.max(0, delivered - included),
        earnedFeeInr,
        unearnedFeeInr: r2(lineFeeInr - earnedFeeInr),
        varianceVsMatrixInr: r2(earnedFeeInr - l.matrixValueInr),
        completionPct: pct1(completion),
      })
    })
  }

  rows.sort((a, b) => b.lineFeeInr - a.lineFeeInr)

  const deptMap = new Map<string, PackageDepartmentTotal>()
  for (const r of rows) {
    let d = deptMap.get(r.departmentId)
    if (!d) {
      d = {
        departmentId: r.departmentId,
        departmentLabel: r.departmentLabel,
        feeInr: 0, earnedFeeInr: 0, unearnedFeeInr: 0, matrixValueInr: 0, varianceVsMatrixInr: 0,
      }
      deptMap.set(r.departmentId, d)
    }
    d.feeInr = r2(d.feeInr + r.lineFeeInr)
    d.earnedFeeInr = r2(d.earnedFeeInr + r.earnedFeeInr)
    d.unearnedFeeInr = r2(d.unearnedFeeInr + r.unearnedFeeInr)
    d.matrixValueInr = r2(d.matrixValueInr + r.matrixValueInr)
    d.varianceVsMatrixInr = r2(d.varianceVsMatrixInr + r.varianceVsMatrixInr)
  }

  const sum = (f: (r: PackageRevenueRow) => number) => r2(rows.reduce((s, r) => s + f(r), 0))

  return {
    rows,
    byDepartment: [...deptMap.values()].sort((a, b) => b.feeInr - a.feeInr),
    totalFeeInr: sum(r => r.lineFeeInr),
    totalEarnedFeeInr: sum(r => r.earnedFeeInr),
    totalUnearnedFeeInr: sum(r => r.unearnedFeeInr),
    totalMatrixValueInr: sum(r => r.matrixValueInr),
    totalVarianceInr: sum(r => r.varianceVsMatrixInr),
  }
}
