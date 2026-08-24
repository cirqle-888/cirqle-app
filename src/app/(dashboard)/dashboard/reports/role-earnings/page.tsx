import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import Header from '@/components/layout/header'
import { groupByRole, groupByPerson, totalEarned, type AwardLine } from '@/lib/ownership/role-earnings'
import { buildComposition, singleRate } from '@/lib/ownership/composition'
import { loadPrograms, loadPeriodComposition } from '@/lib/ownership/engine'
import type { OwnershipPeriod } from '@/lib/ownership/types'
import { HardHat, Users, Lock, ArrowUpRight, ChevronDown, Receipt } from 'lucide-react'

// Awards are recomputed whenever payroll runs — never serve a cached figure.
export const dynamic = 'force-dynamic'

const inr = (n: number) => '₹' + Math.round(n || 0).toLocaleString('en-IN')

/** The plural noun each basis measures, for "2% of collections". */
const BASIS_NOUN: Record<string, string> = {
  billing: 'billing', collected: 'collections', profit: 'profit',
}

function rateLabel(percent: number | null, basis: string): string {
  if (percent != null) return `${percent}% of ${BASIS_NOUN[basis] ?? basis}`
  if (basis === 'fixed') return 'fixed amount'
  if (basis === 'mixed') return 'mixed rates'
  return basis
}

/**
 * Earnings by Role — what each HAT earned, not what each person was paid.
 *
 * Someone running Accounts, HR and a set of CEO-direct clients earns from
 * three ownership rules, each carrying its own role label. Payroll adds them
 * into one `ownership_earned` number and the payslip itemises them for that
 * one person; neither answers "what has the Accounts role cost us this year".
 * This report reads the stored award snapshots and groups them both ways.
 *
 * Scope: everyone with `reports.view` can open it, but without payroll amount
 * visibility the rows are stripped server-side to the viewer's own awards —
 * the same "your rows only" rule the Contributions page applies, so a team
 * member can check their own hats without seeing anyone else's pay.
 */
export default async function RoleEarningsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  // people's earnings — narrower than the old blanket reports.view, which
  // also carried burn rate, runway and every employee's earnings.
  // `reports.view` still admits holders granted before the split.
  const canView = isAdmin
    || me?.permissions.has('reports.view_people_earnings')
    || me?.permissions.has('reports.view')
  if (!canView) redirect('/dashboard')

  const seeEveryone = isAdmin || financialVisibility(me).payrollAmounts
  const myEmployeeId = me?.employeeId ?? null

  const sp = searchParams ? await searchParams : undefined
  const windowMonths = Math.min(24, Math.max(1, parseInt(String(sp?.months ?? '12'), 10) || 12))

  // Awards are keyed on the payroll month they BOOK into, so the window is a
  // list of (month, year) pairs rather than a date range. Filtering by year in
  // SQL and by month in memory keeps the query on the booked_year index while
  // still respecting a window that straddles a year boundary.
  const now = new Date()
  const monthsWindow: { month: number; year: number }[] = []
  for (let i = windowMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    monthsWindow.push({ month: d.getMonth() + 1, year: d.getFullYear() })
  }
  const years = [...new Set(monthsWindow.map(m => m.year))]
  const inWindow = new Set(monthsWindow.map(m => `${m.year}-${m.month}`))

  const admin = createAdminClient()

  // No employee record and no amount visibility means there is nothing this
  // viewer is allowed to see — skip the round-trip entirely.
  const skipQuery = !seeEveryone && !myEmployeeId

  let query = admin
    .from('ownership_awards')
    .select('id, employee_id, earned_inr, basis, percent, booked_month, booked_year, program_id, period_start, period_end, breakdown, program:ownership_programs(name)')
    .in('booked_year', years)
    .order('id', { ascending: true })
  if (!seeEveryone && myEmployeeId) query = query.eq('employee_id', myEmployeeId)

  // fetchAll swallows a missing table (unapplied migration) as an empty result,
  // so this page degrades to its empty state instead of 500ing.
  const { data: awardRows } = skipQuery ? { data: [] as unknown[] } : await fetchAll(query)

  const rows = (awardRows as Record<string, unknown>[])
    .filter(r => inWindow.has(`${r.booked_year}-${r.booked_month}`))

  const awards: AwardLine[] = rows.map(r => {
    const breakdown = (r.breakdown ?? {}) as Record<string, unknown>
    return {
      employeeId: r.employee_id as string,
      label: (breakdown.ruleLabel as string) ?? null,
      programName: (r.program as { name?: string } | null)?.name
        ?? String(breakdown.programName ?? 'Ownership reward'),
      basis: (r.basis as string) ?? 'billing',
      percent: r.percent == null ? null : Number(r.percent),
      earnedInr: Number(r.earned_inr || 0),
      bookedMonth: Number(r.booked_month),
      bookedYear: Number(r.booked_year),
    }
  })

  // CQIDs, not names — the same identifier the Ownership screen shows, and one
  // that carries no personal information for viewers without name access.
  const employeeIds = [...new Set(awards.map(a => a.employeeId))]
  const { data: employees } = employeeIds.length
    ? await admin.from('employees').select('id, cqid').in('id', employeeIds)
    : { data: [] as { id: string; cqid: string }[] }
  const cqidOf = new Map((employees ?? []).map(e => [e.id, e.cqid]))
  const who = (id: string) => cqidOf.get(id) ?? '—'

  const roles = groupByRole(awards)
  const people = groupByPerson(awards)
  const total = totalEarned(awards)

  // ── "Where it came from" ────────────────────────────────────────────────────
  // The composition of ONE program's ONE period, because that is the unit an
  // award is computed over. Spanning the whole window would mix periods whose
  // rates and scopes may differ, and would put a year of tasks in the DOM.
  //
  // Billing amounts are per-client revenue, so this panel needs pricing
  // visibility on top of reaching the page at all.
  const canSeeComposition = financialVisibility(me).tasksPricing

  /** Award periods present in the window, newest first — the panel's options. */
  const periodOptions = [...new Map(rows.map(r => {
    const breakdown = (r.breakdown ?? {}) as Record<string, unknown>
    const key = `${r.program_id}|${r.booked_year}-${String(r.booked_month).padStart(2, '0')}`
    return [key, {
      key,
      programId: r.program_id as string,
      programName: (r.program as { name?: string } | null)?.name ?? 'Ownership reward',
      periodLabel: String(breakdown.periodLabel ?? `${r.booked_year}-${r.booked_month}`),
      start: r.period_start as string,
      end: r.period_end as string,
      bookedMonth: Number(r.booked_month),
      bookedYear: Number(r.booked_year),
    }] as const
  })).values()]
    .sort((a, b) => b.bookedYear - a.bookedYear || b.bookedMonth - a.bookedMonth
      || a.programName.localeCompare(b.programName))

  const selectedKey = String(sp?.at ?? '') || periodOptions[0]?.key
  const selected = periodOptions.find(o => o.key === selectedKey) ?? periodOptions[0] ?? null

  let composition = null as ReturnType<typeof buildComposition> | null
  let compositionBasis = ''
  let clientNameOf = new Map<string, string>()

  if (selected && canSeeComposition) {
    const { programs } = await loadPrograms(admin)
    const program = programs.find(p => p.id === selected.programId) ?? null
    if (program) {
      const period: OwnershipPeriod = {
        start: selected.start, end: selected.end,
        bookedMonth: selected.bookedMonth, bookedYear: selected.bookedYear,
        label: selected.periodLabel,
      }
      // Only the awards actually visible to this viewer set the rate, so a
      // self-scoped viewer sees their own split rather than a colleague's.
      const rate = singleRate(rows
        .filter(r => r.program_id === selected.programId
          && Number(r.booked_month) === selected.bookedMonth
          && Number(r.booked_year) === selected.bookedYear)
        .map(r => (r.percent == null ? null : Number(r.percent))))

      const lines = await loadPeriodComposition(admin, program, period)
      composition = buildComposition(lines, rate)
      compositionBasis = program.basis

      const clientIds = [...new Set(composition.clients.map(c => c.clientId).filter(Boolean))] as string[]
      if (clientIds.length) {
        const { data: clients } = await admin.from('clients').select('id, name, code').in('id', clientIds)
        clientNameOf = new Map((clients ?? []).map(c =>
          [c.id, c.code ? `${c.name} · ${c.code}` : c.name]))
      }
    }
  }

  return (
    <>
      <Header
        title="Earnings by Role"
        subtitle="What each hat earned — Accounts, HR, CEO Direct — from the ownership awards already booked into payroll"
      />
      <div className="p-4 md:p-6 space-y-6">

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Window:</span>
            {[3, 6, 12, 24].map(m => (
              <a
                key={m}
                href={`/dashboard/reports/role-earnings?months=${m}`}
                className={`rounded-lg border px-2.5 py-1 ${m === windowMonths
                  ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                  : 'border-border text-muted-foreground hover:text-foreground'}`}
              >
                {m} months
              </a>
            ))}
          </div>
          <Link
            href="/dashboard/settings/ownership"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Set up roles in Ownership <ArrowUpRight className="h-3 w-3" />
          </Link>
        </div>

        {!seeEveryone && (
          <div className="rounded-xl border border-border bg-card px-4 py-3 flex items-start gap-2.5 text-xs text-muted-foreground">
            <Lock className="h-4 w-4 shrink-0 mt-px" />
            <span>
              Showing your own roles only. Seeing every participant needs payroll amount
              access (<span className="font-mono">payroll.view_amounts</span>).
            </span>
          </div>
        )}

        <div className="rounded-xl border border-border bg-card px-4 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">
              {seeEveryone ? 'Total ownership earnings' : 'Your total ownership earnings'}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Last {windowMonths} months · {roles.length} {roles.length === 1 ? 'role' : 'roles'} · {awards.length} {awards.length === 1 ? 'award' : 'awards'}
            </p>
          </div>
          <span className="text-lg font-semibold tabular-nums">{inr(total)}</span>
        </div>

        {awards.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-4 py-10 text-center">
            <p className="text-sm text-muted-foreground">No ownership awards booked in this window.</p>
            <p className="text-xs text-muted-foreground/70 mt-1.5 max-w-md mx-auto">
              Roles earn once a program pays out: add one in Settings → Ownership, give each
              rule a Role label (&ldquo;Accounts&rdquo;, &ldquo;HR&rdquo;), then run payroll for the month.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* ── By role ─────────────────────────────────────────────────── */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold flex items-center gap-2"><HardHat className="h-4 w-4" />By Role</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Expand a role for who earned it and which months it paid
                </p>
              </div>
              <div className="divide-y divide-border">
                {roles.map(role => (
                  <details key={role.role} className="group">
                    <summary className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm cursor-pointer select-none list-none hover:bg-secondary/50">
                      <div className="min-w-0">
                        <span className="font-medium">{role.role}</span>
                        {!role.labelled && (
                          <span className="text-xs text-muted-foreground/60 ml-2">(program, no role label)</span>
                        )}
                        <span className="text-xs text-muted-foreground ml-2">
                          {role.people.length} {role.people.length === 1 ? 'person' : 'people'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="tabular-nums font-medium">{inr(role.totalInr)}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums w-9 text-right">
                          {total > 0 ? `${Math.round((role.totalInr / total) * 100)}%` : ''}
                        </span>
                        <ChevronDown className="h-4 w-4 text-muted-foreground group-open:rotate-180 transition-transform" />
                      </div>
                    </summary>
                    <div className="px-4 pb-3 pt-1 space-y-3 bg-secondary/30">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1">Who</p>
                        {role.people.map(p => (
                          <div key={p.employeeId} className="flex items-center justify-between gap-3 py-1 text-xs">
                            <span className="min-w-0 truncate">
                              {who(p.employeeId)}
                              <span className="text-muted-foreground ml-1.5">{p.programNames.join(', ')}</span>
                            </span>
                            <span className="tabular-nums">{inr(p.totalInr)}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1">Paid in</p>
                        {role.months.map(m => (
                          <div key={`${m.year}-${m.month}`} className="flex items-center justify-between gap-3 py-1 text-xs">
                            <span className="text-muted-foreground">{m.label}</span>
                            <span className="tabular-nums">{inr(m.totalInr)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            </div>

            {/* ── By person ───────────────────────────────────────────────── */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Users className="h-4 w-4" />By Person</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Every hat one person wears, split out of their payroll total
                </p>
              </div>
              <div className="divide-y divide-border">
                {people.map(person => (
                  <div key={person.employeeId} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium">{who(person.employeeId)}</span>
                      <span className="tabular-nums font-medium">{inr(person.totalInr)}</span>
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {person.hats.map(hat => (
                        <div key={hat.role} className="flex items-center justify-between gap-3 text-xs">
                          <span className="min-w-0 truncate text-muted-foreground">
                            {hat.role}
                            <span className="text-muted-foreground/60 ml-1.5">
                              ({rateLabel(hat.percent, hat.basis)})
                            </span>
                          </span>
                          <span className="tabular-nums text-muted-foreground">{inr(hat.totalInr)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}

        {/* ── Where it came from ─────────────────────────────────────────────
            The composition of one program × one period: which clients
            generated the basis, and which pieces of work inside each. */}
        {awards.length > 0 && canSeeComposition && selected && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Receipt className="h-4 w-4" />Where it came from
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {selected.programName} · {selected.periodLabel}
                {composition && (
                  <> · {inr(composition.totalInr)} of {BASIS_NOUN[compositionBasis] ?? compositionBasis}
                    {composition.ratePercent != null && <> paying {composition.ratePercent}%</>}</>
                )}
              </p>
            </div>

            {periodOptions.length > 1 && (
              <div className="border-b border-border px-4 py-2 flex flex-wrap gap-1.5">
                {periodOptions.map(o => (
                  <a
                    key={o.key}
                    href={`/dashboard/reports/role-earnings?months=${windowMonths}&at=${encodeURIComponent(o.key)}`}
                    className={`rounded-lg border px-2 py-1 text-[11px] ${o.key === selected.key
                      ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                      : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {periodOptions.some(x => x.programName !== o.programName) && `${o.programName} · `}
                    {o.periodLabel}
                  </a>
                ))}
              </div>
            )}

            {!composition || composition.clients.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {compositionBasis === 'profit' || compositionBasis === 'fixed'
                  ? `A ${compositionBasis === 'fixed' ? 'fixed award' : 'profit share'} has no client or task breakdown — ${
                      compositionBasis === 'fixed'
                        ? 'it measures nothing'
                        : 'profit is what is left after earnings, salaries and expenses, not a list of work'}.`
                  : 'Nothing measured in this period.'}
              </p>
            ) : (
              <div className="divide-y divide-border">
                {composition.clients.map(c => (
                  <details key={c.clientId ?? 'none'} className="group">
                    <summary className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm cursor-pointer select-none list-none hover:bg-secondary/50">
                      <div className="min-w-0 truncate">
                        <span className="font-medium">
                          {c.clientId ? clientNameOf.get(c.clientId) ?? '—' : 'No client'}
                        </span>
                        <span className="text-xs text-muted-foreground ml-2">
                          {c.lineCount} {compositionBasis === 'collected'
                            ? (c.lineCount === 1 ? 'receipt' : 'receipts')
                            : (c.lineCount === 1 ? 'task' : 'tasks')}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-[10px] text-muted-foreground tabular-nums w-9 text-right">
                          {c.sharePct}%
                        </span>
                        <span className="tabular-nums text-muted-foreground">{inr(c.totalInr)}</span>
                        {c.earnedInr != null && (
                          <span className="tabular-nums font-medium w-16 text-right">{inr(c.earnedInr)}</span>
                        )}
                        <ChevronDown className="h-4 w-4 text-muted-foreground group-open:rotate-180 transition-transform" />
                      </div>
                    </summary>
                    <div className="px-4 pb-3 pt-1 bg-secondary/30">
                      {c.lines.map((l, i) => (
                        <div key={l.taskId ?? `${l.date}-${i}`} className="flex items-center justify-between gap-3 py-1 text-xs">
                          <span className="min-w-0 truncate text-muted-foreground">
                            {l.taskNumber != null && <span className="text-muted-foreground/60 mr-1.5">#{l.taskNumber}</span>}
                            {l.title ?? '—'}
                            <span className="text-muted-foreground/50 ml-1.5">{l.date}</span>
                          </span>
                          <div className="flex items-center gap-3 shrink-0">
                            <span className="tabular-nums text-muted-foreground/70">{inr(l.amountInr)}</span>
                            {l.earnedInr != null && (
                              <span className="tabular-nums w-16 text-right">{inr(l.earnedInr)}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
