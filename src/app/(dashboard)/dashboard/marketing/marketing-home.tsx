'use client'

/**
 * Marketing — the client list.
 *
 * One job: get to a client fast. Search is focused on arrival (and on "/"),
 * Enter opens the first match, and each card says in one glance what the
 * client has (Pages, campaigns, this month's plan) and whether anything is
 * wrong. Clients with nothing set up yet sit in a compact list underneath, so
 * they never bury the ones being worked on.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Header from '@/components/layout/header'
import {
  Search, Megaphone, CalendarDays, AlertTriangle, ArrowRight, ShieldCheck, Sparkles, ChevronRight, Users,
} from 'lucide-react'
import { PlatformIcon } from '@/components/social-hub/platform-icon'
import { hasMarketing, matchesClient, monthLabel } from '@/lib/marketing/hub'
import type { DirectoryEntry } from '@/lib/marketing/load'
import type { MarketingAccess } from './_access'
import { ClientAvatar, HealthDot, compact, inr } from './_ui'

type Filter = 'all' | 'ads' | 'attention'

interface Props {
  clients: DirectoryEntry[]
  unassignedAssets: number
  cirqleAccounts: number
  month: string
  access: MarketingAccess
}

export default function MarketingHome({ clients, unassignedAssets, cirqleAccounts, month, access }: Props) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [showInactive, setShowInactive] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // "/" jumps to search from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const needsAttention = (c: DirectoryEntry) => c.health !== 'green' || c.issues.length > 0

  const { active, idle, counts } = useMemo(() => {
    const visible = clients.filter(c => matchesClient(c, q))
    const withMarketing = visible.filter(hasMarketing)
    const byFilter = withMarketing.filter(c =>
      filter === 'ads' ? c.liveCampaigns > 0 : filter === 'attention' ? needsAttention(c) : true)
    // Most going on first: attention, then running ads, then reach.
    byFilter.sort((a, b) =>
      Number(needsAttention(b)) - Number(needsAttention(a))
      || b.activeCampaigns - a.activeCampaigns
      || (b.reach30 + b.spend30) - (a.reach30 + a.spend30)
      || a.name.localeCompare(b.name))
    const others = visible
      .filter(c => !hasMarketing(c) && (showInactive || c.isActive))
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      active: byFilter,
      idle: others,
      counts: {
        all: withMarketing.length,
        ads: withMarketing.filter(c => c.liveCampaigns > 0).length,
        attention: withMarketing.filter(needsAttention).length,
      },
    }
  }, [clients, q, filter, showInactive])

  function openFirst() {
    const first = active[0] ?? idle[0]
    if (first) router.push(`/dashboard/marketing/${first.id}`)
  }

  const chips: { key: Filter; label: string; count: number; show: boolean }[] = [
    { key: 'all', label: 'All', count: counts.all, show: true },
    { key: 'ads', label: 'Running ads', count: counts.ads, show: access.ads },
    { key: 'attention', label: 'Needs attention', count: counts.attention, show: true },
  ]

  return (
    <>
      <Header title="Marketing" subtitle="Pick a client to see and manage everything for them in one place" />

      <div className="mx-auto max-w-7xl space-y-6 p-4 md:p-6">
        {/* Hero search */}
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') openFirst() }}
              placeholder="Find a client by name or code…"
              aria-label="Find a client"
              className="h-14 w-full rounded-2xl border border-border bg-card pl-12 pr-16 text-base shadow-sm outline-none transition focus:border-primary/50 focus:ring-4 focus:ring-primary/10"
            />
            <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-border bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground sm:block">/</kbd>
          </div>

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter clients">
            {chips.filter(c => c.show).map(c => (
              <button
                key={c.key}
                onClick={() => setFilter(c.key)}
                aria-pressed={filter === c.key}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === c.key
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground'
                }`}
              >
                {c.key === 'attention' && <AlertTriangle className="h-3 w-3" />}
                {c.key === 'ads' && <Megaphone className="h-3 w-3" />}
                {c.label}
                <span className="tabular-nums opacity-70">{c.count}</span>
              </button>
            ))}
            <span className="ml-auto text-xs text-muted-foreground">Last 30 days · plans for {monthLabel(month)}</span>
          </div>
        </div>

        {/* Setup nudges — only when there is something to do */}
        {(unassignedAssets > 0 || cirqleAccounts > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {unassignedAssets > 0 && (
              <Link href="/dashboard/assets"
                className="group flex items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 transition hover:border-amber-500/50">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{unassignedAssets} page{unassignedAssets === 1 ? '' : 's'} or account{unassignedAssets === 1 ? '' : 's'} without an owner</p>
                  <p className="text-xs text-muted-foreground">They count for no client until assigned</p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">Assign <ArrowRight className="h-3 w-3 transition group-hover:translate-x-0.5" /></span>
              </Link>
            )}
            {cirqleAccounts > 0 && (
              <Link href="/dashboard/cirqle-accounts"
                className="group flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/[0.04] px-4 py-3 transition hover:border-primary/40">
                <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Cirqle’s own marketing</p>
                  <p className="text-xs text-muted-foreground">{cirqleAccounts} account{cirqleAccounts === 1 ? '' : 's'}, kept out of client numbers</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5" />
              </Link>
            )}
          </div>
        )}

        {/* Clients with marketing */}
        <section aria-labelledby="mk-active" className="space-y-3">
          <h2 id="mk-active" className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" /> Clients
            <span className="text-xs font-normal text-muted-foreground">{active.length}</span>
          </h2>
          {active.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/50 px-4 py-10 text-center text-sm text-muted-foreground">
              {q || filter !== 'all' ? 'No client with marketing matches.' : 'No client has Pages, campaigns or a content plan yet.'}
              {idle.length > 0 && <> Pick one below to set them up.</>}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {active.map(c => <ClientCard key={c.id} c={c} access={access} />)}
            </div>
          )}
        </section>

        {/* Everyone else */}
        {(idle.length > 0 || !showInactive) && (
          <section aria-labelledby="mk-idle" className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 id="mk-idle" className="flex items-center gap-2 text-sm font-semibold">
                <Users className="h-4 w-4 text-muted-foreground" /> Not set up yet
                <span className="text-xs font-normal text-muted-foreground">{idle.length}</span>
              </h2>
              <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Include inactive clients
              </label>
            </div>
            {idle.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {idle.map(c => (
                  <Link key={c.id} href={`/dashboard/marketing/${c.id}`}
                    className="group flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 transition hover:border-primary/40">
                    <ClientAvatar id={c.id} name={c.name} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                    {!c.isActive && <span className="text-[10px] text-muted-foreground">Inactive</span>}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                  </Link>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  )
}

function ClientCard({ c, access }: { c: DirectoryEntry; access: MarketingAccess }) {
  const plan = c.plan?.progress
  return (
    <Link
      href={`/dashboard/marketing/${c.id}`}
      className="group flex flex-col gap-4 rounded-2xl border border-border bg-card p-4 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
    >
      <div className="flex items-start gap-3">
        <ClientAvatar id={c.id} name={c.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-semibold">{c.name}</p>
            <HealthDot state={c.issues.length ? 'red' : c.health} className="shrink-0" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {c.instagram > 0 && <span className="inline-flex items-center gap-1"><PlatformIcon platform="instagram" className="h-3.5 w-3.5 text-pink-500" />{c.instagram}</span>}
            {c.facebook > 0 && <span className="inline-flex items-center gap-1"><PlatformIcon platform="facebook_page" className="h-3.5 w-3.5 text-blue-500" />{c.facebook}</span>}
            {access.ads && c.liveCampaigns > 0 && (
              <span className="inline-flex items-center gap-1"><Megaphone className="h-3.5 w-3.5 text-pink-500" />{c.activeCampaigns} live</span>
            )}
            {c.code && <span>#{c.code}</span>}
          </div>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Metric label="Page reach" value={compact(c.reach30)} />
        {access.ads ? <Metric label="Ad spend" value={inr(c.spend30)} /> : <Metric label="Followers" value={compact(c.followers)} />}
        {access.leads ? <Metric label="Leads" value={String(c.leads30)} /> : <Metric label="Pages" value={String(c.pages)} />}
      </div>

      {access.social && (
        plan ? (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1 text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" /> Content plan</span>
              <span className="tabular-nums text-muted-foreground"><span className="font-semibold text-foreground">{plan.done}</span>/{plan.total} done</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500" style={{ width: `${plan.pct}%` }} />
            </div>
          </div>
        ) : (
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CalendarDays className="h-3.5 w-3.5" /> No content plan this month</p>
        )
      )}

      {c.issues.length > 0 && (
        <p className="-mt-1 inline-flex items-center gap-1.5 text-xs text-red-500"><AlertTriangle className="h-3.5 w-3.5" /> {c.issues[0]}</p>
      )}
    </Link>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 px-2 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}
