import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import Header from '@/components/layout/header'
import { fetchJournalLines } from '@/lib/finance/journal'
import { buildCompanyPnl, monthRange } from '@/lib/finance/pnl'
import { computeCompanyOpsStrip } from '@/lib/finance/kpis'
import { SECTION_LABELS } from '@/lib/finance/types'
import { AlertTriangle, Flame, Hourglass, Landmark, Megaphone, MonitorSmartphone, Users2 } from 'lucide-react'

// Live financials — always read fresh.
export const dynamic = 'force-dynamic'

const inr = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** Expenses are negative in the journal; the P&L displays them as magnitudes. */
const inrAbs = (n: number) => (n < 0 ? inr(-n) : inr(n))

const MONTH_LABEL = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return new Date(y, mo - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
}

export default async function CompanyOpsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  // Same wall as Reports: admin OR explicit reports.view (fail-open pre-migration).
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const sp = searchParams ? await searchParams : undefined
  const windowMonths = Math.min(24, Math.max(3, parseInt(String(sp?.months ?? '6'), 10) || 6))

  const admin = createAdminClient()

  // One full-ledger fetch powers everything: bank balance (Σ all-time),
  // the windowed P&L, the KPI strip, and the triage queue.
  const lines = await fetchJournalLines(admin)

  const now = new Date()
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const start = new Date(now.getFullYear(), now.getMonth() - (windowMonths - 1), 1)
  const startMonth = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`
  const months = monthRange(startMonth, thisMonth)

  const bankBalanceInr = Math.round(lines.reduce((s, l) => s + l.amountInr, 0) * 100) / 100
  const companyLines = lines.filter(l => l.scope === 'company')
  const pnl = buildCompanyPnl(companyLines, { months, bankBalanceInr })
  const strip = computeCompanyOpsStrip(lines, { month: thisMonth, bankBalanceInr })

  const untriaged = lines
    .filter(l => l.scope == null)
    .sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="space-y-6">
      <Header
        title="Company Operations"
        subtitle="Cirqle's own P&L — salaries, rent, software, internal marketing — fully separate from client-project profitability"
      />

      {/* ── KPI strip (this month) ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        <Kpi icon={<Landmark className="h-4 w-4" />} label={`Spend · ${MONTH_LABEL(thisMonth)}`} value={inr(strip.opexInr)} />
        <Kpi icon={<Users2 className="h-4 w-4" />} label="Payroll" value={inr(strip.payrollInr)} />
        <Kpi icon={<Megaphone className="h-4 w-4" />} label="Marketing" value={inr(strip.marketingInr)} />
        <Kpi icon={<MonitorSmartphone className="h-4 w-4" />} label="Software" value={inr(strip.softwareInr)} />
        <Kpi icon={<Flame className="h-4 w-4" />} label="Burn rate (3-mo avg)" value={inr(strip.burnRateInr)} />
        <Kpi
          icon={<Hourglass className="h-4 w-4" />}
          label="Runway"
          value={strip.runwayMonths == null ? '—' : `${strip.runwayMonths} mo`}
          hint={`Bank balance ${inr(bankBalanceInr)}`}
        />
      </div>

      {/* ── Window picker ── */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Window:</span>
        {[3, 6, 12, 24].map(m => (
          <Link
            key={m}
            href={`/dashboard/reports/company-ops?months=${m}`}
            className={`rounded-lg border px-2.5 py-1 ${m === windowMonths
              ? 'border-primary/40 bg-primary/10 text-primary font-medium'
              : 'border-border text-muted-foreground hover:text-foreground'}`}
          >
            {m} months
          </Link>
        ))}
      </div>

      {/* ── Monthly P&L ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Company P&L (cash basis)</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Company-scoped cashbook only. Transfers, owner drawings and credit movements never appear here.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium">Account</th>
                {pnl.months.map(m => (
                  <th key={m} className="text-right px-3 py-2 font-medium whitespace-nowrap">{MONTH_LABEL(m)}</th>
                ))}
                <th className="text-right px-4 py-2 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {pnl.sections.map(sec => (
                <SectionRows key={sec.section} sec={sec} months={pnl.months} />
              ))}
              <tr className="border-t-2 border-border font-semibold">
                <td className="px-4 py-2.5">Net operating result</td>
                {pnl.months.map(m => (
                  <td key={m} className={`px-3 py-2.5 text-right tabular-nums whitespace-nowrap ${(pnl.netByMonth[m] ?? 0) < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {inr(pnl.netByMonth[m] ?? 0)}
                  </td>
                ))}
                <td className={`px-4 py-2.5 text-right tabular-nums whitespace-nowrap ${pnl.netTotalInr < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {inr(pnl.netTotalInr)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {pnl.sections.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No company-scoped entries in this window yet. Apply the scope migration and classify entries via the triage queue below.
          </p>
        )}
      </div>

      {/* ── Triage queue ── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <AlertTriangle className={`h-4 w-4 ${untriaged.length ? 'text-amber-500' : 'text-emerald-500'}`} />
              Scope triage queue
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Cashbook entries not yet classified as client or company money — they appear in neither P&L until triaged.
            </p>
          </div>
          <Link
            href="/dashboard/cashbook?scope=untriaged"
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            Triage in Cashbook →
          </Link>
        </div>
        {untriaged.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">All entries are classified. 🎉</p>
        ) : (
          <div className="divide-y divide-border">
            {untriaged.slice(0, 15).map(l => (
              <div key={l.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <div className="min-w-0">
                  <div className="truncate">{l.description || l.categoryName || 'Entry'}</div>
                  <div className="text-xs text-muted-foreground">{l.date}{l.categoryName ? ` · ${l.categoryName}` : ''}</div>
                </div>
                <div className={`tabular-nums whitespace-nowrap ${l.amountInr < 0 ? 'text-red-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {inr(l.amountInr)}
                </div>
              </div>
            ))}
            {untriaged.length > 15 && (
              <p className="px-4 py-2 text-xs text-muted-foreground">+ {untriaged.length - 15} more — open the Cashbook to classify them.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Kpi({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

function SectionRows({ sec, months }: {
  sec: { section: string; label: string; rows: { accountCode: string; label: string; byMonth: Record<string, number>; totalInr: number }[]; byMonth: Record<string, number>; totalInr: number }
  months: string[]
}) {
  return (
    <>
      <tr className="bg-muted/40">
        <td className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground" colSpan={months.length + 2}>
          {SECTION_LABELS[sec.section as keyof typeof SECTION_LABELS] ?? sec.label}
        </td>
      </tr>
      {sec.rows.map(r => (
        <tr key={r.accountCode} className="border-b border-border/50">
          <td className="px-4 py-2">
            <span>{r.label}</span>
            <span className="ml-2 text-[10px] text-muted-foreground font-mono">{r.accountCode}</span>
          </td>
          {months.map(m => (
            <td key={m} className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">
              {r.byMonth[m] != null ? inrAbs(r.byMonth[m]) : '—'}
            </td>
          ))}
          <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{inrAbs(r.totalInr)}</td>
        </tr>
      ))}
      <tr className="border-b border-border font-medium">
        <td className="px-4 py-2 text-xs">Subtotal — {sec.label}</td>
        {months.map(m => (
          <td key={m} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{inrAbs(sec.byMonth[m] ?? 0)}</td>
        ))}
        <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{inrAbs(sec.totalInr)}</td>
      </tr>
    </>
  )
}
