import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowRight, Building2, Lock, Maximize2, Plus, Settings2, ShieldCheck, Users, Wallet } from 'lucide-react'
import Header from '@/components/layout/header'
import { UNIT_KINDS, UNIT_KIND_LABEL, type DeptLedger } from '@/lib/units/engine'
import { loadDepartments, loadLookups, loadShares } from '@/lib/units/load'
import { monthStartISO } from '@/lib/utils/local-date'
import { Badge, Card, Empty, Stat, Table } from '../finance/profit-sharing/_components'
import { inr, td, tdNum } from '../finance/profit-sharing/_format'
import { GeneralCategories, InvoiceAssign, MonthPicker } from './_ui'
import { NotInstalled } from './_not-installed'
import { MONTH, ROOT, monthName, requireUnitViewer } from './_page'

export const dynamic = 'force-dynamic'

const tone = (n: number) => (n > 0 ? 'good' : n < 0 ? 'bad' : 'muted') as 'good' | 'bad' | 'muted'

/**
 * Departments & Brands. Cirqle is the parent; each department (Social Media &
 * Creative, Cirqle Flyers…) and sub-brand (Memoura) is a unit with its own
 * team. Admins see every unit — this month's result, the agreement if there is
 * one, how General costs were split, and money that landed in no unit. A team
 * member sees only their own unit.
 */
export default async function UnitsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { admin, installed, myUnits } = await requireUnitViewer()
  // A plain call, not <MemberIndex admin={…} />: a database client passed as a
  // component prop gets serialised for React's dev tools and breaks the page.
  if (myUnits) return memberIndex(admin, myUnits.map(u => u.id))

  const header = (
    <Header
      title="Departments & Brands"
      subtitle="Cirqle's departments and sub-brands: their teams, results and profit-and-loss agreements."
      actions={installed ? (
        <span className="flex items-center gap-2">
          <Link href={`${ROOT}/hq`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
            <Building2 className="h-3.5 w-3.5" /> Cirqle HQ
          </Link>
          <Link href={`${ROOT}/allocate`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
            <Wallet className="h-3.5 w-3.5" /> Cash Book allocation
          </Link>
          <Link href={`${ROOT}/access`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
            <ShieldCheck className="h-3.5 w-3.5" /> Access map
          </Link>
          <Link href={`${ROOT}/new`} className="gradient-bg inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
            <Plus className="h-3.5 w-3.5" /> New unit
          </Link>
        </span>
      ) : undefined}
    />
  )
  if (!installed) return <>{header}<div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div></>

  const sp = await searchParams
  const thisMonth = monthStartISO(0).slice(0, 7)
  const month = MONTH.test(sp.month ?? '') ? sp.month! : thisMonth

  const [shares, lookups] = await Promise.all([
    loadShares(admin, { fromMonth: month, toMonth: month }),
    loadLookups(admin),
  ])
  const { departments, result, generalCategoryIds } = shares
  const categoryName = new Map(lookups.categories.map(c => [c.id, c.name]))
  const unitName = new Map(departments.map(d => [d.id, d.name]))
  const general = result.general[0]
  const pickerMonths = (() => {
    const first = departments.map(d => d.startsOn.slice(0, 7)).sort()[0] ?? thisMonth
    const out: string[] = []
    let [y, m] = first.split('-').map(Number)
    const [ty, tm] = thisMonth.split('-').map(Number)
    while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++ } }
    return out.length ? out : [thisMonth]
  })()
  const groups: { title: string; list: DeptLedger[] }[] = UNIT_KINDS
    .map(k => ({ title: UNIT_KIND_LABEL[k].many, list: result.ledgers.filter(l => l.department.kind === k) }))
    .filter(g => g.list.length)

  return (
    <>
      {header}
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            You see everything; office staff see what their designation allows; each unit&apos;s team sees only its
            own unit (see the Access map). Showing <span className="font-medium text-foreground">{monthName(month)}</span>.
          </p>
          <MonthPicker months={pickerMonths} value={month} allLabel={null} />
        </div>

        {departments.length === 0 ? (
          <Card>
            <div className="space-y-3 py-4 text-center">
              <p className="text-sm font-medium">No units yet</p>
              <p className="mx-auto max-w-lg text-sm text-muted-foreground">
                Add each department (Social Media &amp; Creative, Cirqle Flyers…) and sub-brand (Memoura): pick the work it
                covers, add its team, and — only where you have one — its profit-and-loss agreement. Its team then sees
                only that unit, and you get its invoices, Cash Book and result in one place, with a Focus mode for meetings.
              </p>
              <Link href={`${ROOT}/new`} className="gradient-bg inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
                <Plus className="h-3.5 w-3.5" /> Add the first unit
              </Link>
            </div>
          </Card>
        ) : groups.map(g => (
          <section key={g.title} className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {g.list.map(l => {
                const d = l.department
                const m = l.months[0]
                return (
                  <Card key={d.id}
                    title={<span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color ?? '#7c3aed' }} />{d.name}{!d.isActive && <Badge>Inactive</Badge>}</span>}
                    subtitle={d.categoryIds.map(c => categoryName.get(c)).filter(Boolean).join(', ') || 'No work picked yet'}
                    actions={(
                      <>
                        <Link href={`${ROOT}/${d.slug}?focus=1&month=${month}`} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary"><Maximize2 className="h-3.5 w-3.5" /> Focus</Link>
                        <Link href={`${ROOT}/${d.slug}/edit`} aria-label={`Edit ${d.name}`} className="rounded-lg border border-border p-1.5 hover:bg-secondary"><Settings2 className="h-3.5 w-3.5" /></Link>
                      </>
                    )}
                  >
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />
                          {d.members.length ? d.members.map(x => x.role === 'lead' ? `${x.cqid} (lead)` : x.cqid).join(', ') : 'No team yet'}</span>
                        <span>·</span>
                        <span>{d.partners.length ? `Agreement ${d.partners.map(p => `${p.cqid} ${p.sharePct}%`).join(' / ')}` : 'No agreement — result stays with Cirqle'}</span>
                      </div>
                      {!m ? (
                        <Empty>Results start in {monthName(d.startsOn.slice(0, 7))}.</Empty>
                      ) : (
                        <>
                          <div className="grid grid-cols-3 gap-2">
                            <Stat label="Income" value={inr(m.incomeInr + m.otherIncomeInr)} />
                            <Stat label="Costs" value={inr(m.directCostsInr + m.generalCostsInr)} hint={`General ${inr(m.generalCostsInr)}`} />
                            <Stat label={m.resultInr < 0 ? 'Loss' : 'Profit'} value={inr(m.resultInr)} tone={tone(m.resultInr)} />
                          </div>
                          {m.partners.length > 0 && (
                            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                              {m.partners.map(p => (
                                <li key={p.employeeId} className="flex items-center justify-between px-3 py-1.5">
                                  <span>{p.cqid} <span className="text-muted-foreground">· {p.sharePct}%</span></span>
                                  <span className={`tabular-nums font-medium ${p.amountInr < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{inr(p.amountInr)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                      <Link href={`${ROOT}/${d.slug}?month=${month}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                        Open workspace <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </Card>
                )
              })}
            </div>
          </section>
        ))}

        {departments.length > 0 && (
          <Card title="General costs" subtitle="Cirqle's shared costs, split equally between every unit that carries general costs.">
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-3">
                <Stat label={`General in ${monthName(month)}`} value={inr(general?.netInr ?? 0)} />
                <Stat label="Split between" value={general?.splitBetween.length ?? 0}
                  hint={general?.splitBetween.map(id => unitName.get(id)).join(', ') || 'No unit carries general costs — Cirqle keeps them'} />
                <Stat label="Each carries" value={inr(general && general.splitBetween.length ? general.netInr / general.splitBetween.length : 0)} />
              </div>
              {general && general.splitBetween.length === 1 && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  Only one unit carries general costs, so it carries all of them. Add Cirqle Flyers and your other units
                  with &ldquo;Carries an equal part of General costs&rdquo; ticked to split them.
                </p>
              )}
              <details className="rounded-lg border border-border">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Categories that are General automatically</summary>
                <div className="border-t border-border p-3">
                  <p className="mb-3 text-xs text-muted-foreground">
                    Company payments in these Cash Book categories count as General without tagging them one by one
                    (for example Software &amp; Subscriptions for GPT, tools and domains). Anything can still be tagged by hand.
                  </p>
                  <GeneralCategories categories={lookups.cashbookCategories} selected={generalCategoryIds} />
                </div>
              </details>
            </div>
          </Card>
        )}

        {departments.length > 0 && result.unassignedIncome.length > 0 && (
          <Card title="Income in no unit" subtitle="Own revenue on these invoices counted in no unit this month. Assign an invoice to put it in one.">
            <Table head={['Invoice', 'Client', 'Issued', 'Own revenue issued', 'Collected', 'Unit']}>
              {result.unassignedIncome.map(({ invoice, invoicedInr, collectedInr }) => (
                <tr key={invoice.id} className="border-b border-border/60 last:border-0">
                  <td className={td}>{invoice.number ?? '—'}</td>
                  <td className={td}>{invoice.clientName ?? '—'}</td>
                  <td className={td}>{invoice.issueDate ?? '—'}</td>
                  <td className={tdNum}>{inr(invoicedInr)}</td>
                  <td className={tdNum}>{inr(collectedInr)}</td>
                  <td className={td}>
                    <InvoiceAssign invoiceId={invoice.id} current={shares.assignments.has(invoice.id) ? shares.assignments.get(invoice.id) ?? null : undefined}
                      departments={departments.filter(d => d.isActive).map(d => ({ id: d.id, name: d.name }))} />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {departments.length > 0 && result.untagged.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {result.untagged.length} company Cash Book {result.untagged.length === 1 ? 'entry' : 'entries'} in {monthName(month)} sit in no
            unit. <Link href={`${ROOT}/allocate?month=${month}`} className="font-medium text-primary hover:underline">Allocate them</Link> — with suggestions.
          </p>
        )}
      </div>
    </>
  )
}

/** A team member's view: their own unit(s) and nothing else. */
async function memberIndex(admin: Parameters<typeof loadDepartments>[0], myUnitIds: string[]) {
  const units = (await loadDepartments(admin)).filter(d => myUnitIds.includes(d.id))
  if (units.length === 1 && units[0].teamSeesResults) redirect(`${ROOT}/${units[0].slug}`)
  return (
    <>
      <Header title={units.length === 1 ? units[0].name : 'My units'} subtitle="Your team and its work." />
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 md:px-6">
        {units.map(d => (
          <Card key={d.id}
            title={<span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color ?? '#7c3aed' }} />{d.name}</span>}
            subtitle={UNIT_KIND_LABEL[d.kind].of}>
            <div className="space-y-3 text-sm">
              <p className="inline-flex items-center gap-1 text-muted-foreground"><Users className="h-4 w-4" />
                {d.members.map(x => x.role === 'lead' ? `${x.cqid} (lead)` : x.cqid).join(', ')}</p>
              {d.teamSeesResults ? (
                <Link href={`${ROOT}/${d.slug}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  Open results <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <p className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" /> Results are not shared with the team.</p>
              )}
            </div>
          </Card>
        ))}
      </div>
    </>
  )
}
