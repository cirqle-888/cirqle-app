import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import Header from '@/components/layout/header'
import { fetchJournalLines } from '@/lib/finance/journal'
import { buildTagSpend } from '@/lib/finance/tags'
import { fetchEmployeeCostSplits, buildEmployeeCostReport } from '@/lib/finance/employee-costs'
import { Tag, Users } from 'lucide-react'

// Live financials — always read fresh.
export const dynamic = 'force-dynamic'

const inr = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/**
 * Cost & Tags — two independent breakdowns over the Finance Engine:
 *
 *   Spend by Tag       free-form labels ("Photoshop", "Design") on any
 *                      outflow, for ad-hoc "how much did we spend on X"
 *                      questions the fixed category taxonomy can't answer.
 *   Cost by Employee    a shared expense (one Photoshop seat, two designers)
 *                      split equally and attributed to each — COST
 *                      attribution, distinct from the Contribution Analysis
 *                      report's LABOR attribution (money earned, not spent).
 */
export default async function CostAttributionPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const sp = searchParams ? await searchParams : undefined
  const windowMonths = Math.min(24, Math.max(1, parseInt(String(sp?.months ?? '6'), 10) || 6))

  const admin = createAdminClient()
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth() - (windowMonths - 1), 1)
    .toISOString().slice(0, 10)

  const [taggedLines, employeeSplits] = await Promise.all([
    fetchJournalLines(admin, { from, includeTags: true }),
    fetchEmployeeCostSplits(admin, { from }),
  ])

  const tagSpend = buildTagSpend(taggedLines)
  const employeeCosts = buildEmployeeCostReport(employeeSplits)
  const totalTagged = tagSpend.reduce((s, r) => s + r.totalInr, 0)
  const totalEmployeeCost = employeeCosts.reduce((s, r) => s + r.totalInr, 0)

  return (
    // Header stays full-bleed (its own padding + sticky border); the content
    // below it gets the standard page inset so it doesn't touch the nav rail.
    <>
      <Header
        title="Cost & Tags"
        subtitle="Ad-hoc spend labels and shared-expense cost attribution — independent of the fixed category taxonomy"
      />
      <div className="p-4 md:p-6 space-y-6">

      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Window:</span>
        {[3, 6, 12, 24].map(m => (
          <a
            key={m}
            href={`/dashboard/reports/cost-attribution?months=${m}`}
            className={`rounded-lg border px-2.5 py-1 ${m === windowMonths
              ? 'border-primary/40 bg-primary/10 text-primary font-medium'
              : 'border-border text-muted-foreground hover:text-foreground'}`}
          >
            {m} months
          </a>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Spend by Tag ── */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="border-b border-border px-4 py-3 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold flex items-center gap-2"><Tag className="h-4 w-4" />Spend by Tag</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Total: {inr(totalTagged)}</p>
            </div>
          </div>
          {tagSpend.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No tagged entries yet — add tags when recording a Cashbook expense.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {tagSpend.map(row => (
                <div key={row.tag} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{row.tag}</span>
                    <span className="text-xs text-muted-foreground ml-2">{row.entryCount} {row.entryCount === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  <div className="tabular-nums font-medium whitespace-nowrap">{inr(row.totalInr)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Cost by Employee ── */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold flex items-center gap-2"><Users className="h-4 w-4" />Cost by Employee</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Total: {inr(totalEmployeeCost)} · shared expenses split equally, not contribution earnings
            </p>
          </div>
          {employeeCosts.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              No split expenses yet — use “Split across employees” on a Cashbook expense.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {employeeCosts.map(row => (
                <div key={row.employeeId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{row.employeeCqid}</span>
                    <span className="text-xs text-muted-foreground ml-2">{row.itemCount} {row.itemCount === 1 ? 'item' : 'items'}</span>
                  </div>
                  <div className="tabular-nums font-medium whitespace-nowrap">{inr(row.totalInr)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  )
}
