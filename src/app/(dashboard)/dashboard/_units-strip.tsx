'use client'

/**
 * Admin dashboard — "Units this month": each of Cirqle's units with its
 * income and result, a way into its workspace and Focus mode, and Cirqle HQ.
 * Reads a streamed promise (see page.tsx); renders nothing when there are no
 * units or the read failed.
 */

import { use } from 'react'
import Link from 'next/link'
import { ArrowRight, Building2, Maximize2 } from 'lucide-react'
import type { UnitsStrip } from '@/lib/units/dashboard-strip'
import { fmt } from './dashboard-utils'

const signed = (n: number) => `${n < 0 ? '−' : ''}${fmt(Math.abs(n))}`

export function UnitsStripSkeleton() {
  return <div className="h-[132px] animate-pulse rounded-2xl border border-border bg-card/50" aria-hidden />
}

export default function UnitsStripPanel({ promise }: { promise: Promise<UnitsStrip | null> }) {
  const strip = use(promise)
  if (!strip) return null
  return (
    <section className="rounded-2xl border border-border bg-card p-4" aria-label="Units this month">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Units this month</h2>
          <p className="text-xs text-muted-foreground">{strip.monthLabel}{strip.noUnitIncomeInr > 0 ? ` · ${fmt(strip.noUnitIncomeInr)} collected in no unit` : ''}</p>
        </div>
        <Link href="/dashboard/units/hq" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary">
          <Building2 className="h-3.5 w-3.5" /> Cirqle HQ
        </Link>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {strip.units.map(u => (
          <div key={u.slug} className="rounded-xl border border-border bg-background/50 p-3">
            <div className="flex items-start justify-between gap-2">
              <Link href={`/dashboard/units/${u.slug}`} className="group min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium group-hover:underline">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: u.color ?? '#7c3aed' }} />
                  <span className="truncate">{u.name}</span>
                </span>
                <span className="text-[11px] text-muted-foreground">{u.kind}{u.startsLabel ? ` · starts ${u.startsLabel}` : ''}</span>
              </Link>
              <Link href={`/dashboard/units/${u.slug}?focus=1`} aria-label={`Focus mode for ${u.name}`}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] hover:bg-secondary">
                <Maximize2 className="h-3 w-3" /> Focus
              </Link>
            </div>
            <div className="mt-2 flex items-end justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Income</div>
                <div className="text-sm font-semibold tabular-nums">{fmt(u.incomeInr)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{u.resultInr < 0 ? 'Loss' : 'Result'}{u.startsLabel ? ' (preview)' : ''}</div>
                <div className={`text-sm font-semibold tabular-nums ${u.resultInr < 0 ? 'text-red-600 dark:text-red-400' : u.resultInr > 0 ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{signed(u.resultInr)}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Link href="/dashboard/units" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
        All units <ArrowRight className="h-3 w-3" />
      </Link>
    </section>
  )
}
