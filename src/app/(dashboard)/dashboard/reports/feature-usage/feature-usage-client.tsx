'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, CircleDashed, CircleAlert, CircleCheck, Info, Users, X as XIcon } from 'lucide-react'
import Header from '@/components/layout/header'
import { addDaysISO, formatISODateShort } from '@/lib/utils/local-date'
import { RHYTHM_LABEL } from '@/lib/feature-usage/catalogue'
import {
  LOOKBACK_DAYS, RECENT_DAYS, WELL_DAYS,
  type FeatureUsageReport, type FeatureUsageRow, type UsageStatus,
} from '@/lib/feature-usage/report'

interface Props {
  report: FeatureUsageReport
  trackingReady: boolean
  trackingSince: string | null
  sources: { visits: number; quickActions: number }
  warnings: string[]
  myCqid: string
}

const PAGE = '/dashboard/reports/feature-usage'

const TABS: { key: UsageStatus; label: string; icon: typeof CircleDashed; tone: string }[] = [
  { key: 'never', label: 'Never used',  icon: CircleDashed, tone: 'text-rose-400' },
  { key: 'rare',  label: 'Used rarely', icon: CircleAlert,  tone: 'text-amber-400' },
  { key: 'well',  label: 'Used well',   icon: CircleCheck,  tone: 'text-emerald-400' },
]

export default function FeatureUsageClient({ report, trackingReady, trackingSince, sources, warnings, myCqid }: Props) {
  const router = useRouter()
  const { person, counts } = report
  const firstWithRows = TABS.find(t => counts[t.key] > 0)?.key ?? 'never'
  const [tab, setTab] = useState<UsageStatus>(firstWithRows)
  const rows = report.rows.filter(r => r.status === tab)

  const pick = (cqid: string) => router.push(cqid ? `${PAGE}?person=${encodeURIComponent(cqid)}` : PAGE)

  const explainer: Record<UsageStatus, string> = person
    ? {
        never: `${person.cqid}'s role allows these, but they have not opened them in the last ${LOOKBACK_DAYS} days.`,
        rare:  `${person.cqid} opens these less often than they are meant to be used.`,
        well:  `${person.cqid} uses these as often as they are meant to be used.`,
      }
    : {
        never: `Nobody has opened these in the last ${LOOKBACK_DAYS} days.`,
        rare:  'Opened, but less often than they are meant to be used.',
        well:  'Used as often as they are meant to be. Keep going.',
      }

  return (
    <>
      <Header
        title="Feature Usage"
        subtitle="Which parts of Cirqle are used, which are not, and how to start each one"
      />
      <div className="p-4 md:p-6 space-y-5 pb-10">

      {!trackingReady && (
        <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
          <p>
            Page visits are not being counted yet. Run{' '}
            <code className="text-xs">supabase/migrations/20261128220000_feature_visits.sql</code>{' '}
            once in the Supabase SQL editor. Until then this page only knows the pages opened from Quick Actions (⌘K),
            so many features will show as never used.
          </p>
        </div>
      )}
      {trackingReady && (!trackingSince || trackingSince > addDaysISO(report.today, -(RECENT_DAYS - 1))) && (
        <div className="flex gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            {trackingSince
              ? `Page visits are counted from ${formatISODateShort(trackingSince)}, so this is under a month of use. Features used once a month may still look unused.`
              : 'Page visits are being counted from today. Come back in a week for a fair picture.'}
          </p>
        </div>
      )}
      {warnings.length > 0 && (
        <p className="text-xs text-amber-500">Some usage could not be read: {warnings.join(' · ')}</p>
      )}

      {/* ── Who ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Person"
          value={person?.cqid ?? ''}
          onChange={e => pick(e.target.value)}
          className="h-10 w-full sm:w-auto max-w-full sm:max-w-md rounded-lg border border-border bg-secondary px-3 text-sm"
        >
          <option value="">Everyone</option>
          {report.people.map(p => (
            <option key={p.id} value={p.cqid}>
              {p.cqid}{p.cqid === myCqid ? ' (you)' : ''}{p.role ? ` · ${p.role}` : ''}
            </option>
          ))}
        </select>
        {person && (
          <button onClick={() => pick('')} className="inline-flex items-center gap-1 h-10 px-3 rounded-lg border border-border bg-secondary text-sm text-muted-foreground hover:text-foreground">
            <XIcon className="w-3.5 h-3.5" /> Show everyone
          </button>
        )}
      </div>

      {person && (
        <div className="rounded-xl border border-border bg-card px-4 py-3">
          <p className="text-sm font-semibold">
            {[person.cqid, roleLabel(person)].filter(Boolean).join(' · ')}
          </p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Has opened {person.usedCount} of the {person.allowedCount} features their role allows
            {person.lastActive ? `, last on ${formatISODateShort(person.lastActive)}` : ''}.
            {person.neverOpened.length > 0 && ` ${person.neverOpened.length} never opened — listed under Never used.`}
          </p>
        </div>
      )}

      {/* ── Buckets ─────────────────────────────────────────────────────── */}
      <div role="tablist" aria-label="Usage" className="grid grid-cols-3 gap-2">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              tab === t.key ? 'border-primary/60 bg-primary/10' : 'border-border bg-card hover:bg-secondary/60'
            }`}
          >
            <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${t.tone}`}>
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </span>
            <span className="block text-2xl font-bold tabular-nums mt-0.5">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <section className="space-y-3">
        <p className="text-sm text-muted-foreground">{explainer[tab]}</p>
        {rows.length === 0 ? (
          <p className="rounded-xl border border-border bg-card px-4 py-6 text-sm text-muted-foreground">Nothing here.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map(r => <FeatureCard key={r.href} row={r} forPerson={!!person} />)}
          </div>
        )}
      </section>

      {/* ── People ──────────────────────────────────────────────────────── */}
      {!person && report.people.length > 0 && (
        <section className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <p className="text-sm font-semibold inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> By person</p>
            <p className="text-xs text-muted-foreground mt-0.5">Features each role allows that the person has never opened. Tap a person to see their list.</p>
          </div>
          <div className="divide-y divide-border">
            {report.people.map(p => (
              <button
                key={p.id}
                onClick={() => pick(p.cqid)}
                className="w-full grid grid-cols-[1fr_auto] sm:grid-cols-[8rem_1fr_auto_auto] items-center gap-x-4 gap-y-0.5 px-4 py-2.5 text-left hover:bg-secondary/50"
              >
                <span className="text-sm font-medium">{p.cqid}{p.cqid === myCqid ? ' (you)' : ''}</span>
                <span className="text-xs text-muted-foreground order-3 sm:order-none col-span-2 sm:col-span-1 truncate">
                  {[roleLabel(p), p.lastActive ? `last active ${formatISODateShort(p.lastActive)}` : 'not seen yet'].filter(Boolean).join(' · ')}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap hidden sm:block">
                  used {p.usedCount} of {p.allowedCount}
                </span>
                <span className={`text-sm font-semibold tabular-nums whitespace-nowrap ${p.neverOpened.length ? 'text-rose-400' : 'text-emerald-400'}`}>
                  {p.neverOpened.length ? `${p.neverOpened.length} never opened` : 'all opened'}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── How it is counted ───────────────────────────────────────────── */}
      <details className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium">How this is counted</summary>
        <ul className="mt-2 space-y-1 text-muted-foreground list-disc pl-5">
          <li>One mark per person, per sidebar page, per day. No times, clicks or record ids are kept.</li>
          <li>
            Used well means used as often as it is meant to be: a daily tool on {WELL_DAYS.daily}+ days of the last {RECENT_DAYS},
            a weekly tool on {WELL_DAYS.weekly}+ days, a monthly tool at least once in {RECENT_DAYS} days, and a set-up tool
            at least once in {LOOKBACK_DAYS} days. Less than that is used rarely.
          </li>
          <li>Never used means not opened in the last {LOOKBACK_DAYS} days.</li>
          <li>Only staff who can sign in are counted. An admin previewing someone (view as) is never counted as them.</li>
          <li>
            The list is the sidebar, so a new page appears here by itself.
            Read this time: {sources.visits} page-visit days, {sources.quickActions} pages opened from Quick Actions.
          </li>
        </ul>
      </details>
      </div>
    </>
  )
}

/** "Designer", "Accounts · Admin", or just "Admin" when the role is already called that. */
function roleLabel(p: { role: string | null; isAdmin: boolean }): string {
  const role = p.role?.trim() || ''
  if (!p.isAdmin || /admin/i.test(role)) return role || (p.isAdmin ? 'Admin' : '')
  return role ? `${role} · Admin` : 'Admin'
}

function FeatureCard({ row, forPerson }: { row: FeatureUsageRow; forPerson: boolean }) {
  const nobody = row.allowed.length > 0 && row.notYetBy.length === row.allowed.length
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{row.label}</p>
          <p className="text-[11px] text-muted-foreground">{row.section} · {RHYTHM_LABEL[row.rhythm]}</p>
        </div>
        <Link
          href={row.href}
          className="shrink-0 inline-flex items-center gap-1 h-8 px-3 rounded-lg gradient-bg text-white text-xs font-medium"
        >
          Open <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      </div>
      <p className="text-sm">{row.what}</p>
      <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">How to start: </span>{row.start}</p>
      <p className="text-xs text-muted-foreground">
        {row.lastUsed ? `Last used ${formatISODateShort(row.lastUsed)}` : 'Not opened yet'}
        {row.activeDays30 > 0 && ` · on ${row.activeDays30} day${row.activeDays30 === 1 ? '' : 's'} in the last ${RECENT_DAYS}`}
        {!forPerson && row.allowed.length > 0 && ` · ${row.usedBy30.length} of ${row.allowed.length} ${row.allowed.length === 1 ? 'person' : 'people'} this month`}
      </p>
      {!forPerson && row.notYetBy.length > 0 && (
        <p className="text-xs">
          <span className="text-muted-foreground">{nobody ? 'Nobody has used it yet. Can use it: ' : 'Never used by: '}</span>
          {row.notYetBy.join(', ')}
        </p>
      )}
    </div>
  )
}
