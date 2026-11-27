import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import Header from '@/components/layout/header'
import { loadAllocation } from '@/lib/units/allocate-load'
import { describeAllocation } from '@/lib/units/suggest'
import { monthStartISO } from '@/lib/utils/local-date'
import { MonthPicker } from '../_ui'
import { NotInstalled } from '../_not-installed'
import { MONTH, ROOT, monthName, requireDepartmentSharesPage } from '../_page'
import { AllocateBoard, type BoardRow } from './allocate-client'

export const dynamic = 'force-dynamic'

/**
 * Cash Book allocation — every company payment and receipt of a month, how it
 * is shared between Cirqle's units (one unit, a split by % or ₹, General, or
 * left out), and a suggestion with its reason for each one still waiting.
 * Admin only.
 */
export default async function AllocatePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { admin, installed } = await requireDepartmentSharesPage()
  const header = <Header title="Cash Book allocation" subtitle="Which unit each company payment belongs to — one unit, a split, General, or left out." crumbLabel="Cash Book allocation" />
  if (!installed) return <>{header}<div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div></>

  const sp = await searchParams
  const thisMonth = monthStartISO(0).slice(0, 7)
  const month = MONTH.test(sp.month ?? '') ? sp.month! : thisMonth
  const months = Array.from({ length: 12 }, (_, i) => monthStartISO(-i).slice(0, 7)).reverse()

  const data = await loadAllocation(admin, month)
  const unitName = new Map(data.units.map(u => [u.id, u.name]))
  const rows: BoardRow[] = data.rows.map(r => ({
    id: r.entry.id,
    date: r.entry.date,
    type: r.entry.type,
    amountInr: r.entry.amountInr,
    description: r.entry.description,
    categoryName: r.entry.categoryName,
    status: r.status,
    current: r.current,
    manual: r.manual,
    split: r.split,
    unitId: r.unitId,
    suggestion: r.suggestion ? {
      label: describeAllocation(r.suggestion.allocation, unitName),
      reason: r.suggestion.reason,
      confidence: r.suggestion.confidence,
    } : null,
  }))

  const sum = (f: (r: BoardRow) => boolean) => Math.round(rows.filter(r => r.type === 'outflow' && f(r)).reduce((t, r) => t + r.amountInr, 0) * 100) / 100
  const totals = {
    payments: sum(() => true),
    units: sum(r => r.status === 'unit'),
    split: sum(r => r.status === 'split'),
    general: sum(r => r.status === 'general'),
    excluded: sum(r => r.status === 'excluded'),
    waiting: sum(r => r.status === 'waiting'),
    waitingCount: rows.filter(r => r.status === 'waiting').length,
    suggested: rows.filter(r => r.status === 'waiting' && r.suggestion).length,
  }

  return (
    <>
      {header}
      <div className="mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={ROOT} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" /> Departments &amp; Brands</Link>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{monthName(month)}</span>
            <MonthPicker months={months} value={month} allLabel={null} />
          </div>
        </div>
        <AllocateBoard
          month={month}
          rows={rows}
          units={data.units}
          totals={totals}
          generalSplitBetween={data.shares.result.general[0]?.splitBetween.map(id => unitName.get(id) ?? '').filter(Boolean) ?? []}
        />
      </div>
    </>
  )
}
