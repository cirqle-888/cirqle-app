import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, Maximize2, Minimize2, Settings2 } from 'lucide-react'
import type { ReactNode } from 'react'
import Header from '@/components/layout/header'
import { loadDeptTasks, loadLookups, loadShares } from '@/lib/units/load'
import type { DeptLedger, DeptMonth } from '@/lib/units/engine'
import { lastDayOfMonthISO, monthStartISO } from '@/lib/utils/local-date'
import { Badge, Card, Empty, Stat, Table } from '../../finance/profit-sharing/_components'
import { inr, td, tdNum } from '../../finance/profit-sharing/_format'
import { BulkTagger, EntryActions, InvoiceAdder, InvoiceAssign, MonthPicker } from '../_ui'
import { NotInstalled } from '../_not-installed'
import { MONTH, ROOT, monthName, requireUnitViewer } from '../_page'

export const dynamic = 'force-dynamic'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'cashbook', label: 'Cash Book' },
  { key: 'work', label: 'Work & Clients' },
] as const
type Tab = typeof TABS[number]['key']

const HOW: Record<string, string> = {
  tagged: 'Tagged', service: 'By service', reversal: 'Reversal', category: 'By category',
}

const money = (n: number) => <span className={n < 0 ? 'text-red-600 dark:text-red-400' : ''}>{inr(n)}</span>

/**
 * One department's workspace: its result and each partner's share, its
 * invoices, its own Cash Book (direct entries plus its part of General), and
 * its work. `?focus=1` shows the same thing full screen with nothing else of
 * the app around it — for sitting down with the team.
 */
export default async function DepartmentPage({ params, searchParams }: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ month?: string; tab?: string; focus?: string }>
}) {
  const { admin, installed, myUnits } = await requireUnitViewer()
  if (!installed) return <div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div>
  const { slug } = await params
  // A team member opens only their own unit, and only when the owner shares
  // its results. Everything they see here is read-only.
  const readOnly = myUnits !== null
  if (readOnly && !myUnits.some(u => u.slug === slug && u.teamSeesResults)) redirect(ROOT)
  // Focus mode is for sitting with the team, so it is view-only too: no list
  // of untagged company entries (they include everyone's salary) and no
  // search across every client's invoices.
  const sp = await searchParams
  const focus = sp.focus === '1'
  const viewOnly = readOnly || focus
  const tab: Tab = (TABS.find(t => t.key === sp.tab)?.key ?? 'overview') as Tab

  const history = await loadShares(admin)
  const ledger = history.result.ledgers.find(l => l.department.slug === slug)
  if (!ledger) notFound()
  const dept = ledger.department

  const thisMonth = monthStartISO(0).slice(0, 7)
  const startMonth = dept.startsOn.slice(0, 7)
  const lastMonth = dept.endsOn && dept.endsOn.slice(0, 7) < thisMonth ? dept.endsOn.slice(0, 7) : thisMonth
  const months = ledger.months.map(m => m.month)
  const wanted = sp.month === 'all' ? 'all' : MONTH.test(sp.month ?? '') ? sp.month! : (months.includes(thisMonth) ? thisMonth : months.at(-1) ?? 'all')
  const month = wanted !== 'all' && !months.includes(wanted) ? (months.at(-1) ?? 'all') : wanted
  const all = month === 'all'

  // Detail lists for the chosen period (the whole agreement for "Since start").
  const period = all ? history : await loadShares(admin, { fromMonth: month, toMonth: month })
  const detail = period.result.ledgers.find(l => l.department.id === dept.id) ?? ledger
  const figures: Omit<DeptMonth, 'month'> = all ? ledger.total : (ledger.months.find(m => m.month === month) ?? detail.total)
  const from = all ? `${startMonth}-01` : `${month}-01`
  const to = (() => { const m = all ? lastMonth : month; const [y, mo] = m.split('-').map(Number); return lastDayOfMonthISO(y, mo) })()

  const [lookups, tasks] = await Promise.all([
    loadLookups(admin),
    tab === 'work' ? loadDeptTasks(admin, dept, from, to) : Promise.resolve([]),
  ])
  const categoryName = new Map(lookups.categories.map(c => [c.id, c.name]))
  const otherDepts = history.departments.filter(d => d.isActive).map(d => ({ id: d.id, name: d.name }))
  const periodLabel = all ? `${monthName(startMonth)} – ${monthName(lastMonth)}` : monthName(month)
  const href = (over: Record<string, string | null>) => {
    const q = new URLSearchParams()
    const base = { tab, month, focus: focus ? '1' : null, ...over }
    for (const [k, v] of Object.entries(base)) if (v && !(k === 'tab' && v === 'overview')) q.set(k, v)
    const s = q.toString()
    return `${ROOT}/${dept.slug}${s ? `?${s}` : ''}`
  }

  const tabs = (
    <nav className="flex gap-1 overflow-x-auto border-b border-border" aria-label={`${dept.name} sections`}>
      {TABS.map(t => (
        <Link key={t.key} href={href({ tab: t.key })}
          className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${tab === t.key
            ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
          {t.label}
        </Link>
      ))}
    </nav>
  )

  const body = (
    <div className="space-y-6">
      {tab === 'overview' && <Overview ledger={ledger} figures={figures} periodLabel={periodLabel} all={all} month={month}
        categories={dept.categoryIds.map(c => categoryName.get(c) ?? '').filter(Boolean)}
        generalSplit={(all ? null : period.result.general[0]?.splitBetween.length) ?? null} />}
      {tab === 'invoices' && <Invoices ledger={detail} assignments={history.assignments} departments={otherDepts} periodLabel={periodLabel} readOnly={viewOnly} />}
      {tab === 'cashbook' && <CashBook ledger={detail} untagged={viewOnly ? [] : period.result.untagged} figures={figures} periodLabel={periodLabel} readOnly={viewOnly} />}
      {tab === 'work' && <Work ledger={detail} tasks={tasks} periodLabel={periodLabel} />}
    </div>
  )

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <MonthPicker months={months.length ? months : [startMonth]} value={month} />
      {focus ? (
        <Link href={href({ focus: null })} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
          <Minimize2 className="h-3.5 w-3.5" /> Exit focus
        </Link>
      ) : readOnly ? null : (
        <>
          <Link href={href({ focus: '1' })} className="gradient-bg inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white hover:opacity-90">
            <Maximize2 className="h-3.5 w-3.5" /> Focus mode
          </Link>
          <Link href={`${ROOT}/${dept.slug}/edit`} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-secondary">
            <Settings2 className="h-3.5 w-3.5" /> Agreement
          </Link>
        </>
      )}
    </div>
  )

  if (focus) {
    // Full screen over the whole app: no sidebar, no other menus or figures.
    return (
      <div className="fixed inset-0 z-[90] overflow-y-auto bg-background">
        <div className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <div className="flex items-center gap-3">
              <span className="h-3 w-3 rounded-full" style={{ background: dept.color ?? '#7c3aed' }} />
              <div>
                <div className="text-base font-semibold leading-tight">{dept.name}</div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Focus mode · {periodLabel}</div>
              </div>
            </div>
            {toolbar}
          </div>
          <div className="mx-auto max-w-6xl px-4 md:px-6">{tabs}</div>
        </div>
        <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">{body}</div>
      </div>
    )
  }

  return (
    <>
      <Header title={dept.name} subtitle={`${dept.kind === 'brand' ? 'Sub-brand' : 'Department'} workspace · ${periodLabel}`} crumbLabel={dept.name} actions={toolbar} />
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 md:px-6">
        {!readOnly && <Link href={ROOT} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" /> All units</Link>}
        {tabs}
        {body}
      </div>
    </>
  )
}

// ═══ Overview ═══════════════════════════════════════════════════════════════

function Overview({ ledger, figures, periodLabel, all, month, categories, generalSplit }: {
  ledger: DeptLedger; figures: Omit<DeptMonth, 'month'>; periodLabel: string; all: boolean; month: string
  categories: string[]; generalSplit: number | null
}) {
  const d = ledger.department
  const income = figures.incomeInr + figures.otherIncomeInr
  const costs = figures.directCostsInr + figures.generalCostsInr
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Income" value={inr(income)} hint={figures.otherIncomeInr ? `incl. other income ${inr(figures.otherIncomeInr)}` : d.revenueBasis === 'collected' ? 'money collected' : 'invoices issued'} />
        <Stat label="Direct costs" value={inr(figures.directCostsInr)} />
        <Stat label="Share of General" value={inr(figures.generalCostsInr)} hint={generalSplit ? `split equally between ${generalSplit}` : undefined} />
        <Stat label={figures.resultInr < 0 ? 'Loss' : 'Profit'} value={inr(figures.resultInr)} tone={figures.resultInr > 0 ? 'good' : figures.resultInr < 0 ? 'bad' : 'muted'} hint={`income ${inr(income)} − costs ${inr(costs)}`} />
      </div>

      {figures.partners.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          No profit-and-loss agreement for this unit — its result stays with Cirqle.
        </p>
      ) : (
      <Card title={`Each partner's share · ${periodLabel}`} subtitle="Profit and loss are shared the same way.">
        <div className="grid gap-3 sm:grid-cols-3">
          {figures.partners.map(p => (
            <div key={p.employeeId} className="rounded-lg border border-border bg-background/50 p-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">{p.cqid}</span>
                <span className="text-xs text-muted-foreground">{p.sharePct}%</span>
              </div>
              <div className={`mt-2 text-2xl font-semibold tabular-nums ${p.amountInr < 0 ? 'text-red-600 dark:text-red-400' : p.amountInr > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{inr(p.amountInr)}</div>
            </div>
          ))}
        </div>
      </Card>
      )}

      <Card title="Month by month" subtitle="Since the agreement started.">
        {ledger.months.length === 0 ? <Empty>No months yet.</Empty> : (
          <Table head={['Month', 'Income', 'Direct costs', 'General', 'Result', ...ledger.department.partners.map(p => `${p.cqid} ${p.sharePct}%`)]}>
            {[...ledger.months].reverse().map(m => (
              <tr key={m.month} className={`border-b border-border/60 last:border-0 ${!all && m.month === month ? 'bg-primary/5' : ''}`}>
                <td className={td}>{monthName(m.month)}</td>
                <td className={tdNum}>{inr(m.incomeInr + m.otherIncomeInr)}</td>
                <td className={tdNum}>{inr(m.directCostsInr)}</td>
                <td className={tdNum}>{inr(m.generalCostsInr)}</td>
                <td className={`${tdNum} font-medium`}>{money(m.resultInr)}</td>
                {m.partners.map(p => <td key={p.employeeId} className={tdNum}>{money(p.amountInr)}</td>)}
              </tr>
            ))}
            <tr className="border-t-2 border-border font-semibold">
              <td className={td}>Total</td>
              <td className={tdNum}>{inr(ledger.total.incomeInr + ledger.total.otherIncomeInr)}</td>
              <td className={tdNum}>{inr(ledger.total.directCostsInr)}</td>
              <td className={tdNum}>{inr(ledger.total.generalCostsInr)}</td>
              <td className={tdNum}>{money(ledger.total.resultInr)}</td>
              {ledger.total.partners.map(p => <td key={p.employeeId} className={tdNum}>{money(p.amountInr)}</td>)}
            </tr>
          </Table>
        )}
      </Card>

      <Card title={d.kind === 'brand' ? 'The sub-brand' : 'The department'}>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Work that counts">{categories.join(', ') || '—'}</Row>
          <Row label="Team">{d.members.map(m => m.role === 'lead' ? `${m.cqid} (lead)` : m.cqid).join(', ') || '—'}</Row>
          <Row label="Agreement">{d.partners.length ? d.partners.map(p => `${p.cqid} ${p.sharePct}%`).join(' · ') : 'None — the result stays with Cirqle'}</Row>
          <Row label="Results from">{monthName(d.startsOn.slice(0, 7))}{d.endsOn ? ` · ends ${monthName(d.endsOn.slice(0, 7))}` : ''}</Row>
          <Row label="Income counted">{d.revenueBasis === 'collected' ? 'When payment is collected' : 'When the invoice is issued'} — own revenue only, never ad spend, rebilled costs or tax</Row>
          <Row label="General costs">{d.sharesGeneralCosts ? 'Carries an equal part' : 'Does not carry any'}</Row>
        </dl>
      </Card>
    </>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}

// ═══ Invoices ═══════════════════════════════════════════════════════════════

function Invoices({ ledger, assignments, departments, periodLabel, readOnly }: {
  ledger: DeptLedger; assignments: Map<string, string | null>; departments: { id: string; name: string }[]; periodLabel: string; readOnly: boolean
}) {
  const d = ledger.department
  const rows = ledger.invoices
  const own = rows.reduce((s, r) => s + r.ownInr, 0)
  const collected = rows.reduce((s, r) => s + r.collectedInr, 0)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Invoices" value={rows.length} hint={periodLabel} />
        <Stat label="Own revenue issued" value={inr(own)} hint="this department's part" />
        <Stat label="Collected" value={inr(collected)} hint="this department's part" />
      </div>
      <Card title="Invoices in this unit"
        subtitle="Issued or paid in the period. An invoice counts here through its services, or because it was added whole."
        actions={readOnly ? undefined : <InvoiceAdder departmentId={d.id} departmentName={d.name} />}>
        {rows.length === 0 ? <Empty>No invoices in this period.</Empty> : (
          <Table head={['Invoice', 'Client', 'Issued', 'Status', 'How', 'Own revenue', 'Collected', ...(readOnly ? [] : [''])]}>
            {rows.map(r => (
              <tr key={r.invoiceId} className="border-b border-border/60 last:border-0">
                <td className={td}>{readOnly ? <span className="font-medium">{r.number ?? '—'}</span> : <Link href={`/dashboard/invoices?id=${r.invoiceId}`} className="font-medium hover:underline">{r.number ?? '—'}</Link>}</td>
                <td className={td}>{r.clientName ?? '—'}</td>
                <td className={td}>{r.issueDate ?? '—'}</td>
                <td className={td}><Badge tone={r.status === 'paid' ? 'good' : r.status === 'overdue' ? 'bad' : 'muted'}>{r.status}</Badge></td>
                <td className={td}>{r.how === 'assigned' ? <Badge tone="info">Added whole</Badge> : r.fraction < 0.999 ? <span className="text-xs text-muted-foreground">{Math.round(r.fraction * 100)}% of lines</span> : <span className="text-xs text-muted-foreground">By services</span>}</td>
                <td className={tdNum}>{inr(r.ownInr)}</td>
                <td className={tdNum}>{inr(r.collectedInr)}</td>
                {!readOnly && <td className={td}><InvoiceAssign invoiceId={r.invoiceId} current={assignments.has(r.invoiceId) ? assignments.get(r.invoiceId) ?? null : undefined} departments={departments} /></td>}
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}

// ═══ Cash Book ══════════════════════════════════════════════════════════════

function CashBook({ ledger, untagged, figures, periodLabel, readOnly }: {
  ledger: DeptLedger
  untagged: { id: string; date: string; type: 'inflow' | 'outflow'; amountInr: number; description: string | null; categoryName: string | null }[]
  figures: Omit<DeptMonth, 'month'>
  periodLabel: string
  readOnly: boolean
}) {
  const d = ledger.department
  const direct = ledger.entries.filter(e => !e.general)
  const general = ledger.entries.filter(e => e.general)
  const amount = (type: 'inflow' | 'outflow', n: number) => (
    <span className={type === 'inflow' ? 'text-emerald-600 dark:text-emerald-400' : ''}>{type === 'inflow' ? '+' : '−'}{inr(n)}</span>
  )
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Direct costs" value={inr(figures.directCostsInr)} hint={figures.otherIncomeInr ? `other income ${inr(figures.otherIncomeInr)}` : periodLabel} />
        <Stat label="Share of General" value={inr(figures.generalCostsInr)} hint="split equally" />
        {!readOnly && <Stat label="Waiting to be tagged" value={untagged.length} hint="company entries in no unit" />}
      </div>

      <Card title="This unit's entries" subtitle="Tagged to it, or carrying one of its services.">
        {direct.length === 0 ? <Empty>No entries in this period.</Empty> : (
          <Table head={['Date', 'Description', 'Category', 'Amount', 'How', ...(readOnly ? [] : [''])]}>
            {direct.map(e => (
              <tr key={e.entryId} className="border-b border-border/60 last:border-0">
                <td className={td}>{e.date}</td>
                <td className={td}>{e.description ?? '—'}</td>
                <td className={td}>{e.categoryName ?? '—'}</td>
                <td className={tdNum}>{amount(e.type, e.amountInr)}</td>
                <td className={td}><span className="text-xs text-muted-foreground">{HOW[e.how] ?? e.how}</span></td>
                {!readOnly && <td className={td}><EntryActions entryId={e.entryId} departmentId={d.id} departmentName={d.name} mode={e.how === 'tagged' ? 'direct-tagged' : 'direct-auto'} /></td>}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="General costs" subtitle={d.sharesGeneralCosts ? 'Shared costs, split equally between the departments that carry them. This department’s part is on the right.' : 'This department does not carry general costs.'}>
        {general.length === 0 ? <Empty>No General entries in this period.</Empty> : (
          <Table head={['Date', 'Description', 'Category', 'Full amount', 'This unit', 'How', ...(readOnly ? [] : [''])]}>
            {general.map(e => (
              <tr key={e.entryId} className="border-b border-border/60 last:border-0">
                <td className={td}>{e.date}</td>
                <td className={td}>{e.description ?? '—'}</td>
                <td className={td}>{e.categoryName ?? '—'}</td>
                <td className={tdNum}>{amount(e.type, e.amountInr)}</td>
                <td className={`${tdNum} font-medium`}>{amount(e.type, e.shareInr)}</td>
                <td className={td}><span className="text-xs text-muted-foreground">{HOW[e.how] ?? e.how}</span></td>
                {!readOnly && <td className={td}><EntryActions entryId={e.entryId} departmentId={d.id} departmentName={d.name} mode={e.how === 'tagged' ? 'general-tagged' : 'general-auto'} /></td>}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {!readOnly && <Card title="Company entries in no unit"
        subtitle="Cash Book payments and receipts that are not invoice payments, transfers or rebilled costs. Tag what belongs to this unit, or mark shared costs General."
        actions={<BulkTagger entryIds={untagged.map(e => e.id)} departmentId={d.id} departmentName={d.name} />}>
        {untagged.length === 0 ? <Empty>Nothing waiting — every entry is in a unit, General, or left out.</Empty> : (
          <Table head={['Date', 'Description', 'Category', 'Amount', '']}>
            {untagged.map(e => (
              <tr key={e.id} className="border-b border-border/60 last:border-0">
                <td className={td}>{e.date}</td>
                <td className={td}>{e.description ?? '—'}</td>
                <td className={td}>{e.categoryName ?? '—'}</td>
                <td className={tdNum}>{amount(e.type, e.amountInr)}</td>
                <td className={td}><EntryActions entryId={e.id} departmentId={d.id} departmentName={d.name} mode="untagged" /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>}
    </>
  )
}

// ═══ Work & clients ═════════════════════════════════════════════════════════

function Work({ ledger, tasks, periodLabel }: {
  ledger: DeptLedger
  tasks: Awaited<ReturnType<typeof loadDeptTasks>>
  periodLabel: string
}) {
  const byStatus = new Map<string, number>()
  for (const t of tasks) byStatus.set(t.status ?? 'unknown', (byStatus.get(t.status ?? 'unknown') ?? 0) + 1)
  const clients = new Map<string, { name: string; tasks: number; invoices: number; ownInr: number }>()
  const clientRow = (name: string) => {
    let r = clients.get(name)
    if (!r) { r = { name, tasks: 0, invoices: 0, ownInr: 0 }; clients.set(name, r) }
    return r
  }
  for (const t of tasks) clientRow(t.client ?? 'Internal').tasks++
  for (const i of ledger.invoices) { const r = clientRow(i.clientName ?? '—'); r.invoices++; r.ownInr += i.ownInr || i.collectedInr }
  const clientList = [...clients.values()].sort((a, b) => b.ownInr - a.ownInr || b.tasks - a.tasks)

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Tasks" value={tasks.length} hint={periodLabel} />
        <Stat label="Completed" value={(byStatus.get('completed') ?? 0) + (byStatus.get('done') ?? 0)} />
        <Stat label="Clients" value={clientList.length} />
        <Stat label="Work billed" value={inr(tasks.reduce((s, t) => s + t.billingInr, 0))} hint="tasks' billing value" />
      </div>

      <Card title="Clients" subtitle="Clients this department worked for or invoiced in the period.">
        {clientList.length === 0 ? <Empty>No clients in this period.</Empty> : (
          <Table head={['Client', 'Tasks', 'Invoices', 'Own revenue']}>
            {clientList.map(c => (
              <tr key={c.name} className="border-b border-border/60 last:border-0">
                <td className={td}>{c.name}</td>
                <td className={tdNum}>{c.tasks}</td>
                <td className={tdNum}>{c.invoices}</td>
                <td className={tdNum}>{inr(c.ownInr)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Tasks" subtitle="Work on this department's services, by task date.">
        {tasks.length === 0 ? <Empty>No tasks in this period.</Empty> : (
          <Table head={['Date', 'Task', 'Client', 'Service', 'Status', 'Billing']}>
            {tasks.slice(0, 300).map(t => (
              <tr key={t.id} className="border-b border-border/60 last:border-0">
                <td className={td}>{t.date}</td>
                <td className={td}><Link href={`/dashboard/tasks?focus=${t.id}`} className="hover:underline">{t.title || (t.number ? `#${t.number}` : 'Task')}</Link></td>
                <td className={td}>{t.client ?? '—'}</td>
                <td className={td}>{t.service ?? '—'}</td>
                <td className={td}><span className="text-xs">{t.status ?? '—'}</span></td>
                <td className={tdNum}>{inr(t.billingInr)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  )
}
