import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient, fetchAll, fetchAllIn } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import Header from '@/components/layout/header'
import { monthRange } from '@/lib/finance/pnl'
import { expensesFromLines, getPeriodProfit, loadOverheadPolicy } from '@/lib/finance/profit'
import { fetchJournalLines } from '@/lib/finance/journal'
import {
  RANGE_PRESETS, formatRangeLabel, monthOverlapFraction, resolveReportRange, toProfitMonths,
} from '@/lib/finance/report-range'
import {
  buildDepartmentPnl, buildEmployeeEarningsMatrix, UNASSIGNED_DEPARTMENT_ID,
  type DepartmentInput, type DepartmentPnlRow, type EmployeeEarningCell,
} from '@/lib/finance/department-pnl'
import { buildPackageRevenue, type PackageItemInput } from '@/lib/finance/package-revenue'
import { cycleForMonth, isDelivered, isPackageInForceForMonth } from '@/lib/packages/progress'
import { CheckCircle2, Info, Package, TriangleAlert } from 'lucide-react'

// Live financials — always read fresh.
export const dynamic = 'force-dynamic'

const ROUTE = '/dashboard/reports/department-pnl'

const inr = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const signClass = (n: number) =>
  n < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'

export default async function DepartmentPnlPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  // Same wall as Reports and Company Operations.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || me?.permissions.has('reports.view')
  if (!canView) redirect('/dashboard')

  const sp = searchParams ? await searchParams : undefined
  const one = (k: string) => {
    const v = sp?.[k]
    return Array.isArray(v) ? v[0] : v
  }

  // Business-calendar dates (Asia/Kolkata), never `new Date().toISOString()`.
  const range = resolveReportRange({ months: one('months'), from: one('from'), to: one('to') })

  const admin = createAdminClient()

  // ── Department dimension: service → category ───────────────────────────────
  const [{ data: cats }, { data: svcs }] = await Promise.all([
    fetchAll(admin.from('service_categories').select('id, name').order('display_order').order('name')),
    fetchAll(admin.from('services').select('id, name, category_id')),
  ])
  const categoryName = new Map<string, string>()
  for (const c of (cats || []) as { id: string; name: string }[]) categoryName.set(c.id, c.name)
  const serviceCategory = new Map<string, string | null>()
  const serviceName = new Map<string, string>()
  for (const s of (svcs || []) as { id: string; name: string; category_id: string | null }[]) {
    serviceCategory.set(s.id, s.category_id)
    serviceName.set(s.id, s.name)
  }

  const departmentLabelOf = (id: string): string =>
    id === UNASSIGNED_DEPARTMENT_ID ? 'Unassigned' : categoryName.get(id) ?? 'Unknown category'

  // ── Measured half: revenue + labour, by department ─────────────────────────
  // `to` is inclusive, matching how every other date filter in the app reads.
  const { data: taskRows, error: taskError } = await fetchAll(
    admin.from('tasks')
      .select('id, billing_amount_inr, service_id, package_id, status, task_date')
      .gte('task_date', range.from)
      .lte('task_date', range.to)
      .is('deleted_at', null),
  )
  const tasks = (taskRows || []) as {
    id: string
    billing_amount_inr: number | null
    service_id: string | null
    package_id: string | null
    status: string | null
    task_date: string
  }[]

  /** Which department a task belongs to — unassigned when the chain breaks. */
  const departmentOf = (serviceId: string | null): string =>
    serviceId ? serviceCategory.get(serviceId) ?? UNASSIGNED_DEPARTMENT_ID : UNASSIGNED_DEPARTMENT_ID

  const taskDepartment = new Map<string, string>()
  const revenueBy = new Map<string, number>()
  const countBy = new Map<string, number>()
  for (const t of tasks) {
    const dep = departmentOf(t.service_id)
    taskDepartment.set(t.id, dep)
    revenueBy.set(dep, (revenueBy.get(dep) ?? 0) + Number(t.billing_amount_inr || 0))
    countBy.set(dep, (countBy.get(dep) ?? 0) + 1)
  }

  // Contribution earnings on those tasks — the labour that produced the revenue,
  // carrying who earned it. CQID only; names are never selected (privacy gate).
  const { data: scoreRows, error: scoreError } = await fetchAllIn(
    (chunk: string[]) => admin.from('contribution_scores')
      .select('task_id, employee_id, earnings_inr').in('task_id', chunk),
    tasks.map(t => t.id),
  )
  const scores = (scoreRows || []) as {
    task_id: string | null; employee_id: string | null; earnings_inr: number | null
  }[]

  const labourBy = new Map<string, number>()
  for (const s of scores) {
    const dep = s.task_id ? taskDepartment.get(s.task_id) : undefined
    if (!dep) continue        // orphan score — no task, so no department
    labourBy.set(dep, (labourBy.get(dep) ?? 0) + Number(s.earnings_inr || 0))
  }

  const { data: empRows } = await fetchAllIn(
    (chunk: string[]) => admin.from('employees').select('id, cqid').in('id', chunk),
    scores.map(s => s.employee_id).filter((v): v is string => Boolean(v)),
  )
  const cqidOf = new Map<string, string>()
  for (const e of (empRows || []) as { id: string; cqid: string | null }[]) {
    cqidOf.set(e.id, e.cqid || '—')
  }

  const cells: EmployeeEarningCell[] = []
  for (const s of scores) {
    const dep = s.task_id ? taskDepartment.get(s.task_id) : undefined
    if (!dep || !s.employee_id) continue
    cells.push({
      employeeId: s.employee_id,
      employeeCqid: cqidOf.get(s.employee_id) ?? '—',
      departmentId: dep,
      earningsInr: Number(s.earnings_inr || 0),
      taskCount: 1,
    })
  }
  const matrix = buildEmployeeEarningsMatrix(cells)

  // ── Apportioned half: the pools ────────────────────────────────────────────
  // A month-aligned range reuses the profit engine, so the reconciliation below
  // is exact and snapshot-aware. A part-month range cannot reconcile — a
  // month's profit snapshot is indivisible — so the pools are measured directly
  // from the journal and salaries are pro-rated by day count.
  let allocatableOpexInr = 0
  let baseSalariesInr = 0
  let engineProfitInr: number | null = null
  let engineTerms: { revenueInr: number; contributionInr: number; frozen: boolean } | null = null

  if (range.monthAligned) {
    const p = await getPeriodProfit(admin, toProfitMonths(range.months))
    allocatableOpexInr = p.expensesInr
    baseSalariesInr = p.baseSalariesInr
    engineProfitInr = p.profitInr
    engineTerms = { revenueInr: p.revenueInr, contributionInr: p.contributionInr, frozen: p.frozen }
  } else {
    const [policy, lines] = await Promise.all([
      loadOverheadPolicy(admin, range.to),
      fetchJournalLines(admin, { from: range.from, to: range.to, scope: 'company' }),
    ])
    allocatableOpexInr = expensesFromLines(lines, policy)

    // Pro-rate each overlapping month's recorded base salaries by days covered.
    //
    // ONE query for the whole range, grouped in memory. This used to issue a
    // query per month inside the loop — 24 sequential round trips for a
    // two-year custom range, purely to sum a handful of rows each time.
    const spannedMonths = monthRange(range.from.slice(0, 7), range.to.slice(0, 7))
    const spannedYears = [...new Set(spannedMonths.map(m => Number(m.slice(0, 4))))]
    const { data: payrollRows } = await fetchAll(
      admin.from('payroll').select('month, year, base_salary').in('year', spannedYears),
    )
    const salaryByMonth = new Map<string, number>()
    for (const r of (payrollRows || []) as { month: number; year: number; base_salary: number | null }[]) {
      const key = `${r.year}-${String(r.month).padStart(2, '0')}`
      salaryByMonth.set(key, (salaryByMonth.get(key) || 0) + Number(r.base_salary || 0))
    }
    for (const m of spannedMonths) {
      const [year, month] = m.split('-').map(Number)
      baseSalariesInr += (salaryByMonth.get(m) || 0)
        * monthOverlapFraction(month, year, range.from, range.to)
    }
    baseSalariesInr = Math.round(baseSalariesInr * 100) / 100
  }

  const departmentIds = new Set<string>([...revenueBy.keys(), ...labourBy.keys()])
  const inputs: DepartmentInput[] = [...departmentIds].map(id => ({
    departmentId: id,
    departmentName: departmentLabelOf(id),
    revenueInr: revenueBy.get(id) ?? 0,
    directLabourInr: labourBy.get(id) ?? 0,
    taskCount: countBy.get(id) ?? 0,
  }))

  const pnl = buildDepartmentPnl(inputs, { allocatableOpexInr, baseSalariesInr })

  // ── Packaged work: fee earned vs price-matrix value ────────────────────────
  // Revenue above counts every task at its MATRIX price. For work sold inside a
  // package that is the wrong number — the client pays a fee, not per task — so
  // the difference is reported here rather than quietly folded into revenue.
  const windowMonths = monthRange(range.from.slice(0, 7), range.to.slice(0, 7))
  const [{ data: pkgRows }, { data: pkgItemRows }, { data: fxRows }] = await Promise.all([
    fetchAll(admin.from('client_packages')
      .select('id, client_id, name, billing_type, price, currency, start_date, end_date, first_cycle_end, status, deleted_at')
      .is('deleted_at', null)),
    fetchAll(admin.from('client_package_items').select('package_id, service_id, included_quantity')),
    fetchAll(admin.from('exchange_rates').select('currency, rate_to_inr')),
  ])
  const rateOf = new Map<string, number>([['INR', 1]])
  for (const f of (fxRows || []) as { currency: string; rate_to_inr: number | null }[]) {
    rateOf.set(f.currency, Number(f.rate_to_inr) || 1)
  }

  const packages = (pkgRows || []) as {
    id: string; client_id: string; name: string
    billing_type: 'one_time' | 'monthly'
    price: number | null; currency: string | null
    start_date: string; end_date: string | null; first_cycle_end: string | null
    status: string; deleted_at: string | null
  }[]

  const pkgClientIds = [...new Set(packages.map(p => p.client_id).filter(Boolean))]
  const { data: pkgClientRows } = await fetchAllIn(
    (chunk: string[]) => admin.from('clients').select('id, name').in('id', chunk),
    pkgClientIds,
  )
  const pkgClientName = new Map<string, string>()
  for (const c of (pkgClientRows || []) as { id: string; name: string | null }[]) {
    pkgClientName.set(c.id, c.name || 'Unnamed client')
  }

  const itemsByPackage = new Map<string, { service_id: string; included_quantity: number }[]>()
  for (const it of (pkgItemRows || []) as {
    package_id: string; service_id: string; included_quantity: number
  }[]) {
    const arr = itemsByPackage.get(it.package_id)
    if (arr) arr.push(it)
    else itemsByPackage.set(it.package_id, [it])
  }

  const packageInputs: PackageItemInput[] = []
  for (const pkg of packages) {
    const items = itemsByPackage.get(pkg.id) ?? []
    if (items.length === 0) continue

    // How many fees fall in this window. A monthly package bills once per
    // billing cycle, and an extended opening cycle is ONE fee across two
    // months — deduping on billingMonth is what keeps it from double-counting.
    let cycleCount = 0
    if (pkg.billing_type === 'one_time') {
      cycleCount = pkg.start_date >= range.from && pkg.start_date <= range.to ? 1 : 0
    } else {
      const billingMonths = new Set<string>()
      for (const m of windowMonths) {
        if (!isPackageInForceForMonth(pkg, m)) continue
        billingMonths.add(cycleForMonth(pkg, m).billingMonth)
      }
      cycleCount = billingMonths.size
    }
    if (cycleCount === 0) continue

    const rate = rateOf.get(pkg.currency || 'INR') ?? 1
    const packageFeeInr = Math.round(Number(pkg.price || 0) * rate * cycleCount * 100) / 100

    for (const it of items) {
      const delivered = tasks.filter(t =>
        t.package_id === pkg.id && t.service_id === it.service_id && isDelivered(t.status))
      packageInputs.push({
        packageId: pkg.id,
        packageName: pkg.name,
        clientLabel: pkgClientName.get(pkg.client_id) ?? 'Unknown client',
        billingType: pkg.billing_type,
        packageFeeInr,
        serviceId: it.service_id,
        serviceLabel: serviceName.get(it.service_id) ?? 'Unknown service',
        departmentId: departmentOf(it.service_id),
        departmentLabel: departmentLabelOf(departmentOf(it.service_id)),
        includedQty: it.included_quantity * cycleCount,
        deliveredQty: delivered.length,
        matrixValueInr: delivered.reduce((s, t) => s + Number(t.billing_amount_inr || 0), 0),
      })
    }
  }
  const packageRevenue = buildPackageRevenue(packageInputs)

  const drift = engineProfitInr == null
    ? null
    : Math.round((pnl.reconciliationInr - engineProfitInr) * 100) / 100
  const reconciled = drift != null && Math.abs(drift) < 0.01
  const readFailed = Boolean(taskError || scoreError)
  const unassigned = pnl.rows.find(r => r.departmentId === UNASSIGNED_DEPARTMENT_ID)
  const orphanLabour = Math.round(
    (pnl.totals.directLabourInr - matrix.grandTotalInr) * 100) / 100

  return (
    <div className="space-y-6">
      <Header
        title="Department P&L"
        subtitle="Profitability by discipline, and who earned what inside each one"
      />

      {readFailed && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm flex items-start gap-2">
          <TriangleAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-red-500">Partial read — figures below are incomplete.</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              A page of tasks or contribution scores failed to load. Reload before relying on these numbers.
            </p>
          </div>
        </div>
      )}

      {/* ── Period ── */}
      <div className="rounded-xl border border-border bg-card px-4 py-3 space-y-3">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="text-muted-foreground">Period:</span>
          {RANGE_PRESETS.map(m => (
            <Link
              key={m}
              href={`${ROUTE}?months=${m}`}
              className={`rounded-lg border px-2.5 py-1 ${range.presetMonths === m
                ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                : 'border-border text-muted-foreground hover:text-foreground'}`}
            >
              {m === 1 ? 'This month' : `${m} months`}
            </Link>
          ))}
          <span className="font-medium ml-1">{formatRangeLabel(range)}</span>
        </div>

        {/* Plain GET form — no client JS needed, and the resulting URL is shareable. */}
        <form method="GET" action={ROUTE} className="flex items-end gap-2 flex-wrap text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">Custom from</span>
            <input
              type="date" name="from" defaultValue={range.from}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">to</span>
            <input
              type="date" name="to" defaultValue={range.to}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-foreground"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg border border-primary/40 bg-primary/10 text-primary font-medium px-3 py-1.5 hover:bg-primary/20"
          >
            Apply
          </button>
          {range.presetMonths === null && (
            <Link href={ROUTE} className="text-muted-foreground hover:text-foreground px-1 py-1.5">
              Reset
            </Link>
          )}
        </form>
      </div>

      {/* ── What is measured vs apportioned ── */}
      <div className="rounded-xl border border-border bg-secondary/30 px-4 py-3 text-xs flex items-start gap-2">
        <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
        <div className="space-y-1 text-muted-foreground">
          <p>
            <strong className="text-foreground">Department = service category.</strong> No cost row in
            this database carries a department (the cashbook has no unit column, employees have no
            department), so <strong className="text-foreground">revenue and direct labour are actual</strong> —
            traced task → service → category — while <strong className="text-foreground">overhead and
            salaries are apportioned by revenue share</strong>, not incurred.
          </p>
          <p>
            Judge a department on <strong className="text-foreground">contribution margin</strong> (measured).
            The operating result depends on an allocation choice.
          </p>
        </div>
      </div>

      {/* ── The statement ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
          <div>
          <h2 className="text-sm font-semibold">Profitability by department</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {pnl.totals.taskCount.toLocaleString('en-IN')} tasks across {pnl.rows.length} departments
            · overhead pool {inr(pnl.allocatableOpexInr)} · salary pool {inr(pnl.baseSalariesInr)}
            {!range.monthAligned && ' (pro-rated by days)'}
          </p>
          </div>
          <Link
            href="/dashboard/reports/department-growth?months=12"
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary whitespace-nowrap"
          >
            Department cards →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">Department</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Revenue</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Direct labour</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Contribution margin</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">%</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap text-muted-foreground/70">Alloc. overhead</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap text-muted-foreground/70">Alloc. salaries</th>
                <th className="text-right px-4 py-2 font-medium whitespace-nowrap">Operating result</th>
              </tr>
            </thead>
            <tbody>
              {pnl.rows.map(r => <DepartmentRow key={r.departmentId} r={r} />)}
              {pnl.rows.length > 0 && (
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-4 py-2.5">{pnl.totals.departmentName}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(pnl.totals.revenueInr)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(pnl.totals.directLabourInr)}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(pnl.totals.contributionMarginInr)}`}>
                    {inr(pnl.totals.contributionMarginInr)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                    {pnl.totals.contributionMarginPct}%
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{inr(pnl.totals.allocatedOpexInr)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{inr(pnl.totals.allocatedSalariesInr)}</td>
                  <td className={`px-4 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(pnl.totals.operatingResultInr)}`}>
                    {inr(pnl.totals.operatingResultInr)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pnl.rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No tasks in this period.
          </p>
        )}
      </div>

      {/* ── Packaged work ── */}
      {packageRevenue.rows.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              Packaged work — fee earned vs price-matrix value
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              The Revenue column above prices every task at the matrix rate. Work sold inside a
              package is not paid that way — the client pays a fee — so the two numbers are shown
              side by side here instead of one silently standing in for the other.
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-border border-b border-border">
            <PackageStat label="Package fees in period" value={inr(packageRevenue.totalFeeInr)} />
            <PackageStat label="Earned (delivered)" value={inr(packageRevenue.totalEarnedFeeInr)} tone="ok" />
            <PackageStat
              label="Balance — paid, not delivered"
              value={inr(packageRevenue.totalUnearnedFeeInr)}
              tone={packageRevenue.totalUnearnedFeeInr > 0 ? 'warn' : undefined}
            />
            <PackageStat
              label="Matrix value counted above"
              value={inr(packageRevenue.totalMatrixValueInr)}
              hint={`${packageRevenue.totalVarianceInr >= 0 ? 'Understates' : 'Overstates'} packaged revenue by ${inr(Math.abs(packageRevenue.totalVarianceInr))}`}
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2 font-medium">Package · line</th>
                  <th className="text-left px-3 py-2 font-medium">Department</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Delivered</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Fee</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Earned</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Balance</th>
                  <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Matrix value</th>
                  <th className="text-right px-4 py-2 font-medium whitespace-nowrap">Variance</th>
                </tr>
              </thead>
              <tbody>
                {packageRevenue.rows.map(r => (
                  <tr key={`${r.packageId}-${r.serviceId}`} className="border-b border-border/50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{r.packageName}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {r.serviceLabel} · {r.clientLabel} · {r.billingType === 'monthly' ? 'monthly' : 'one-time'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{r.departmentLabel}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                      {r.deliveredQty} / {r.includedQty}
                      <div className="text-[11px] text-muted-foreground">
                        {r.completionPct}%{r.extraQty > 0 ? ` · +${r.extraQty} extra` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(r.lineFeeInr)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-emerald-600 dark:text-emerald-400">
                      {inr(r.earnedFeeInr)}
                    </td>
                    <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${r.unearnedFeeInr > 0 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                      {inr(r.unearnedFeeInr)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                      {inr(r.matrixValueInr)}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(r.varianceVsMatrixInr)}`}>
                      {r.varianceVsMatrixInr >= 0 ? '+' : ''}{inr(r.varianceVsMatrixInr)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="px-4 py-3 text-xs text-muted-foreground border-t border-border space-y-1">
            <p>
              <strong className="text-foreground">Earned</strong> = fee × delivered ÷ included, capped at
              the fee — over-delivery bills as an extra, it does not earn more of the retainer.{' '}
              <strong className="text-foreground">Balance</strong> is the fee taken for work not yet
              delivered: deferred revenue and an obligation, not profit.
            </p>
            <p>
              These figures are <strong className="text-foreground">not</strong> added to the statement
              above — doing so would double-count the covered tasks, which already appear there at
              matrix price. Treat the variance as the correction the statement needs.
            </p>
            <p>
              A fee belongs to its whole billing cycle. If the period you picked cuts a cycle in half,
              the full cycle fee still shows here against only the deliveries inside your period, so
              completion reads low — compare whole cycles before drawing a conclusion from it.
            </p>
          </div>
        </div>
      )}

      {/* ── Who earned what ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Earnings by employee &amp; department</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Contribution earnings only — the same rupees as the Direct labour column above, split by
            who earned them. Each column total ties back to its department.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium sticky left-0 bg-card">Employee</th>
                {pnl.rows.map(d => (
                  <th key={d.departmentId} className="text-right px-3 py-2 font-medium whitespace-nowrap">
                    {d.departmentName}
                  </th>
                ))}
                <th className="text-right px-4 py-2 font-medium whitespace-nowrap">Total</th>
                <th className="text-right px-3 py-2 font-medium whitespace-nowrap">Share</th>
              </tr>
            </thead>
            <tbody>
              {matrix.rows.map(e => (
                <tr key={e.employeeId} className="border-b border-border/50">
                  <td className="px-4 py-2.5 font-medium sticky left-0 bg-card whitespace-nowrap">
                    {e.employeeCqid}
                    <div className="text-[11px] font-normal text-muted-foreground">
                      {e.totalTaskCount.toLocaleString('en-IN')} tasks
                    </div>
                  </td>
                  {pnl.rows.map(d => {
                    const v = e.byDepartment[d.departmentId]
                    const n = e.taskCountByDepartment[d.departmentId]
                    return (
                      <td key={d.departmentId} className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                        {v == null
                          ? <span className="text-muted-foreground/40">—</span>
                          : <>
                              {inr(v)}
                              <div className="text-[11px] text-muted-foreground">{n} tasks</div>
                            </>}
                      </td>
                    )
                  })}
                  <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium">{inr(e.totalInr)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{e.sharePct}%</td>
                </tr>
              ))}
              {matrix.rows.length > 0 && (
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-4 py-2.5 sticky left-0 bg-card">All employees</td>
                  {pnl.rows.map(d => (
                    <td key={d.departmentId} className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                      {inr(matrix.departmentTotals[d.departmentId] ?? 0)}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(matrix.grandTotalInr)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">100%</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {matrix.rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No contribution earnings in this period.
          </p>
        )}
        {Math.abs(orphanLabour) >= 0.01 && (
          <p className="px-4 py-3 text-xs text-muted-foreground border-t border-border">
            {inr(orphanLabour)} of direct labour has no employee attached (earnings-only imports) and
            is counted in the statement above but not in this table.
          </p>
        )}
      </div>

      {/* ── Reconciliation ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            {drift == null
              ? <Info className="h-4 w-4 text-muted-foreground" />
              : reconciled
                ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                : <TriangleAlert className="h-4 w-4 text-amber-500" />}
            Reconciliation to the profit engine
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Department results must sum to company profit for the same period, or the split is wrong.
          </p>
        </div>
        {drift == null ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Not available for a part-month period. The profit engine works in whole months and a
            locked month&apos;s snapshot cannot be divided, so overhead here was measured straight from
            the journal for {formatRangeLabel(range)} and salaries pro-rated by day count.
            Pick whole months to get an exact tie-out.
          </p>
        ) : (
          <>
            <div className="divide-y divide-border text-sm">
              <ReconRow label="Σ department operating results" value={inr(pnl.reconciliationInr)} />
              <ReconRow label="Profit engine · same period" value={inr(engineProfitInr!)} />
              <ReconRow label="Difference" value={inr(drift)} emphasis={reconciled ? 'ok' : 'warn'} />
            </div>
            {!reconciled && (
              <p className="px-4 py-3 text-xs text-muted-foreground border-t border-border">
                A non-zero difference means live task billing has changed since a locked month was
                frozen. The profit engine returns the snapshot for closed months; this report measures
                tasks live.
              </p>
            )}
            {engineTerms && (
              <div className="px-4 py-3 text-xs text-muted-foreground border-t border-border">
                Period profit = revenue {inr(engineTerms.revenueInr)} − contribution{' '}
                {inr(engineTerms.contributionInr)} − salaries {inr(pnl.baseSalariesInr)} − expenses{' '}
                {inr(pnl.allocatableOpexInr)}.
                {engineTerms.frozen && ' All months in this period are locked (frozen snapshots).'}
              </div>
            )}
          </>
        )}
      </div>

      {unassigned && unassigned.taskCount > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm flex items-start gap-2">
          <TriangleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {unassigned.taskCount.toLocaleString('en-IN')} tasks ({inr(unassigned.revenueInr)}) have no department.
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Their service has no category, or the task has no service. Assign a category to those
              services in the catalog and this bucket shrinks to zero.
            </p>
            <Link href="/dashboard/catalog" className="text-xs text-primary underline underline-offset-2 mt-1 inline-block">
              Open Catalog →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function DepartmentRow({ r }: { r: DepartmentPnlRow }) {
  const isUnassigned = r.departmentId === UNASSIGNED_DEPARTMENT_ID
  return (
    <tr className={`border-b border-border/50 ${isUnassigned ? 'bg-amber-500/5' : ''}`}>
      <td className="px-4 py-2.5">
        <Link
          href={`/dashboard/reports/department-growth/${encodeURIComponent(r.departmentId)}?months=12`}
          className="font-medium hover:text-primary hover:underline underline-offset-2"
        >
          {r.departmentName}
        </Link>
        <div className="text-[11px] text-muted-foreground">
          {r.taskCount.toLocaleString('en-IN')} tasks · {r.revenueSharePct}% of revenue
        </div>
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(r.revenueInr)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">{inr(r.directLabourInr)}</td>
      <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap font-medium ${signClass(r.contributionMarginInr)}`}>
        {inr(r.contributionMarginInr)}
      </td>
      <td className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${signClass(r.contributionMarginInr)}`}>
        {r.contributionMarginPct}%
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{inr(r.allocatedOpexInr)}</td>
      <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">{inr(r.allocatedSalariesInr)}</td>
      <td className={`px-4 py-2.5 text-right tabular-nums whitespace-nowrap font-medium ${signClass(r.operatingResultInr)}`}>
        {inr(r.operatingResultInr)}
        <div className="text-[11px] font-normal text-muted-foreground">{r.operatingMarginPct}%</div>
      </td>
    </tr>
  )
}

function PackageStat({ label, value, hint, tone }: {
  label: string; value: string; hint?: string; tone?: 'ok' | 'warn'
}) {
  const toneClass = tone === 'ok'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'warn' ? 'text-amber-500' : ''
  return (
    <div className="px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function ReconRow({ label, value, emphasis }: {
  label: string; value: string; emphasis?: 'ok' | 'warn'
}) {
  const tone = emphasis === 'ok'
    ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
    : emphasis === 'warn' ? 'text-amber-500 font-semibold' : ''
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className={emphasis ? tone : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular-nums whitespace-nowrap ${tone}`}>{value}</span>
    </div>
  )
}
