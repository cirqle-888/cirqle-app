'use client'

/**
 * Client Marketing Hub — everything for one client in one place.
 *
 *   Overview · Pages · Ads · Content · Leads
 *
 * Overview answers "how is this client doing and what needs me?" in one
 * screen; each other tab is where that kind of work gets done. The client
 * switcher sits in the header so moving between clients never means going
 * back to a list. Tab state lives in the URL (?tab=), so every view is
 * linkable and the browser's back button behaves.
 */

import { useMemo } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Header from '@/components/layout/header'
import Combobox from '@/components/ui/combobox'
import {
  ArrowLeft, ArrowRight, CalendarDays, Eye, Heart, LayoutDashboard, Megaphone, PenSquare, Plus,
  Share2, Target, UserPlus, Users, Wallet,
} from 'lucide-react'
import { PROGRESS_CHIP, PROGRESS_LABEL, resolveItemProgress } from '@/lib/social/plan'
import type { AttentionItem } from '@/lib/advertising/attention'
import { accountHealth, monthLabel, monthStartISO } from '@/lib/marketing/hub'
import type { ClientMarketing } from '@/lib/marketing/load'
import { periodRange } from '@/lib/advertising/period'
import {
  AttentionPanel, allocationsByProject, buildCampaignCards, computeAttentionItems,
} from '../../advertising/advertising-client'
import ClientWorkspace from '../../advertising/clients/[clientId]/client-workspace'
import type { MarketingAccess } from '../_access'
import { AccountAvatar, ClientAvatar, DateBadge, EmptyHint, HealthDot, Panel, Stat, compact, inr, type HubClient } from '../_ui'
import PagesTab from './pages-tab'
import ContentTab from './content-tab'
import LeadsTab from './leads-tab'

type Tab = 'overview' | 'pages' | 'ads' | 'content' | 'leads'
type WorkspaceProps = React.ComponentProps<typeof ClientWorkspace>
export type HubAds = Omit<WorkspaceProps, 'client' | 'embedded' | 'tabKey'>

interface Props {
  client: HubClient
  clients: HubClient[]
  withMarketing: string[]
  hub: ClientMarketing
  issues: AttentionItem[]
  ads: HubAds | null
  access: MarketingAccess
  today: string
}

export default function ClientHub({ client, clients, withMarketing, hub, issues, ads, access, today }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const tabs = useMemo(() => {
    const t: { key: Tab; label: string; count?: number; icon: typeof LayoutDashboard }[] = [
      { key: 'overview', label: 'Overview', icon: LayoutDashboard },
    ]
    if (access.social || access.assets) t.push({ key: 'pages', label: 'Pages', count: hub.accounts.length, icon: Share2 })
    if (ads) t.push({ key: 'ads', label: 'Ads', count: ads.projects.filter(p => !p.archived_at).length, icon: Megaphone })
    if (access.social) t.push({ key: 'content', label: 'Content', icon: CalendarDays })
    if (access.leads) t.push({ key: 'leads', label: 'Leads', count: hub.leads30, icon: UserPlus })
    return t
  }, [access, ads, hub])

  const rawTab = searchParams.get('tab') as Tab | null
  const tab: Tab = rawTab && tabs.some(t => t.key === rawTab) ? rawTab : 'overview'

  function selectTab(next: Tab) {
    const q = new URLSearchParams()
    if (next !== 'overview') q.set('tab', next)
    // Native history updates useSearchParams without a server round trip.
    window.history.replaceState(null, '', q.size ? `${pathname}?${q}` : pathname)
  }

  // Ads: the same cards the Advertising screens build, over the last 30 days.
  const range = useMemo(() => periodRange('30d', today), [today])
  const adCards = useMemo(() => {
    if (!ads) return []
    return buildCampaignCards(ads.projects, ads.metricsByProject, allocationsByProject(ads.ledger), ads.benchmarksByProject, range)
  }, [ads, range])
  const liveCards = useMemo(() => adCards.filter(c => !c.p.archived_at), [adCards])
  const adIssues = useMemo(
    () => (ads ? computeAttentionItems(ads.attention, adCards, ads.metricsByProject, ads.walletSupported) : []),
    [ads, adCards],
  )
  const allIssues = useMemo(() => {
    const rank = { critical: 0, warning: 1, info: 2 } as const
    return [...issues, ...adIssues.map(i => ({ ...i, clientName: null }))].sort((a, b) => rank[a.severity] - rank[b.severity])
  }, [issues, adIssues])

  const adSpend30 = liveCards.reduce((s, c) => s + (c.periodAgg.spend || 0), 0)
  const adResults = useMemo(() => {
    const by = new Map<string, { label: string; costLabel: string; count: number; spend: number }>()
    for (const c of liveCards) {
      const m = c.definition.metric
      if (!m || c.periodResults == null) continue
      const g = by.get(m) ?? { label: c.definition.label, costLabel: c.definition.costLabel, count: 0, spend: 0 }
      g.count += c.periodResults
      g.spend += c.periodAgg.spend || 0
      by.set(m, g)
    }
    return [...by.values()]
  }, [liveCards])

  const health: 'green' | 'amber' | 'red' = allIssues.some(i => i.severity === 'critical') ? 'red'
    : allIssues.some(i => i.severity === 'warning') ? 'amber' : 'green'

  const planHref = hub.currentPlan ? `/dashboard/social-calendar?calendar=${hub.currentPlan.id}` : '/dashboard/social-calendar'
  const switcherOptions = useMemo(() => {
    const pinned = new Set(withMarketing)
    return clients
      .filter(c => c.isActive || c.id === client.id || pinned.has(c.id))
      .map(c => ({
        id: c.id, label: c.name, sub: c.code ? `#${c.code}` : undefined,
        group: pinned.has(c.id) ? 'With marketing' : undefined,
      }))
      .sort((a, b) => Number(!!b.group) - Number(!!a.group) || a.label.localeCompare(b.label))
  }, [clients, withMarketing, client.id])

  const summary = [
    hub.accounts.length ? `${hub.accounts.length} page${hub.accounts.length === 1 ? '' : 's'}` : null,
    ads ? `${liveCards.filter(c => c.p.status === 'active').length} live campaign${liveCards.filter(c => c.p.status === 'active').length === 1 ? '' : 's'}` : null,
    access.social ? (hub.currentPlan ? `${monthLabel(hub.currentPlan.month)} plan ${hub.currentPlan.progress.pct}% done` : 'no plan this month') : null,
  ].filter(Boolean).join(' · ')

  return (
    <>
      <Header title={client.name} crumbLabel={client.name} />

      <div className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Link href="/dashboard/marketing" aria-label="All clients"
              className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <ClientAvatar id={client.id} name={client.name} size={48} />
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-xl font-bold leading-tight tracking-tight sm:text-2xl">
                <span className="break-words">{client.name}</span>
                <HealthDot state={health} className="shrink-0" />
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">{summary || 'Nothing set up yet'}</p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="w-full sm:w-64">
              <Combobox
                options={switcherOptions}
                value={client.id}
                onChange={id => { if (id && id !== client.id) router.push(`/dashboard/marketing/${id}`) }}
                placeholder="Switch client…"
                sortKey="clients"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {access.social && (
                <Link href={planHref}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition hover:border-primary/40">
                  <CalendarDays className="h-4 w-4 text-violet-500" /> Plan content
                </Link>
              )}
              {access.socialPublish && hub.accounts.length > 0 && (
                <Link href={`/dashboard/social/calendar?client=${client.id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition hover:border-primary/40">
                  <PenSquare className="h-4 w-4 text-blue-500" /> Compose
                </Link>
              )}
              {ads?.perms.create && (
                <Link href={`/dashboard/advertising/new?client=${client.id}`}
                  className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white transition hover:opacity-90">
                  <Plus className="h-4 w-4" /> New campaign
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* ── Tabs ─────────────────────────────────────────────────────────── */}
        <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
          <div role="tablist" aria-label="Client marketing" className="inline-flex min-w-full gap-1 rounded-xl border border-border bg-card p-1 md:min-w-0">
            {tabs.map(t => {
              const Icon = t.icon
              const on = tab === t.key
              return (
                <button key={t.key} role="tab" aria-selected={on} onClick={() => selectTab(t.key)}
                  className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    on ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                  }`}>
                  <Icon className="h-4 w-4" />
                  {t.label}
                  {t.count != null && t.count > 0 && (
                    <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${on ? 'bg-white/20' : 'bg-secondary'}`}>{t.count}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Overview ─────────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              {access.social && (
                <>
                  <Stat icon={Users} tone="pink" label="Followers" value={compact(hub.social30.followers)}
                    sub={`across ${hub.accounts.length} account${hub.accounts.length === 1 ? '' : 's'}`} />
                  <Stat icon={Eye} tone="blue" label="Reach" value={compact(hub.social30.reach)} sub={`${compact(hub.social30.views)} views · 30 days`} />
                  <Stat icon={Heart} tone="violet" label="Engagement" value={compact(hub.social30.interactions)}
                    sub={`${hub.social30.posts} post${hub.social30.posts === 1 ? '' : 's'} published`} />
                </>
              )}
              {ads && (
                <>
                  <Stat icon={Wallet} tone="amber" label="Ad spend" value={inr(adSpend30)} sub="30 days · excl. GST" />
                  <Stat icon={Target} tone="emerald" label={adResults[0]?.label ?? 'Ad results'}
                    value={adResults[0] ? adResults[0].count.toLocaleString('en-IN') : '—'}
                    sub={adResults[0] && adResults[0].count > 0 ? `${adResults[0].costLabel} ${inr(adResults[0].spend / adResults[0].count, 2)}` : 'no results in 30 days'} />
                </>
              )}
              {access.leads && (
                <Stat icon={UserPlus} tone="emerald" label="Leads" value={String(hub.leads30)} sub={`${hub.leadCounts30.new} new · 30 days`} />
              )}
              {access.social && !ads && (
                <Stat icon={CalendarDays} tone="violet" label="Content plan"
                  value={hub.currentPlan ? `${hub.currentPlan.progress.done}/${hub.currentPlan.progress.total}` : '—'}
                  sub={hub.currentPlan ? `${monthLabel(hub.currentPlan.month)} · done` : 'No plan this month'} />
              )}
            </div>

            <AttentionPanel items={allIssues} canSnooze={false} />

            <div className="grid gap-4 lg:grid-cols-2">
              {(access.social || access.assets) && (
                <Panel title="Pages & accounts" icon={Share2}
                  action={<TabLink onClick={() => selectTab('pages')}>Manage</TabLink>}>
                  {hub.accounts.length === 0 ? (
                    <EmptyHint text="No Facebook Page or Instagram account yet."
                      cta={access.assets ? { href: '/dashboard/assets', label: 'Assign one' } : undefined} />
                  ) : (
                    <ul className="space-y-2.5">
                      {hub.accounts.map(a => {
                        const h = accountHealth(a)
                        return (
                          <li key={a.id} className="flex items-center gap-3">
                            <AccountAvatar url={a.profile_picture_url} platform={a.platform} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{a.name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {a.username ? `@${a.username}` : a.platform === 'instagram' ? 'Instagram' : 'Facebook Page'}
                                {a.followers_count != null && ` · ${compact(a.followers_count)} followers`}
                              </p>
                            </div>
                            <span className="text-right text-xs tabular-nums text-muted-foreground">
                              <span className="block font-semibold text-foreground">{compact(a.reach30)}</span>reach
                            </span>
                            <HealthDot state={h.state} />
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </Panel>
              )}

              {ads && (
                <Panel title="Campaigns" icon={Megaphone}
                  action={<TabLink onClick={() => selectTab('ads')}>Open ads</TabLink>}>
                  {liveCards.length === 0 ? (
                    <EmptyHint text="No campaigns for this client yet."
                      cta={ads.perms.create ? { href: `/dashboard/advertising/new?client=${client.id}`, label: 'New campaign' } : undefined} />
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {liveCards.slice(0, 5).map(c => (
                        <li key={c.p.id}>
                          <Link href={`/dashboard/advertising/${c.p.id}`} className="group flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                            <span className={`h-2 w-2 shrink-0 rounded-full ${c.p.status === 'active' ? 'bg-emerald-500' : c.p.status === 'paused' ? 'bg-amber-500' : 'bg-gray-400'}`} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium group-hover:text-primary">{c.p.campaign_name}</p>
                              <p className="text-xs text-muted-foreground">
                                {c.definition.label}: {c.periodResults ?? '—'}
                                {c.periodResults ? ` · ${c.definition.costLabel} ${inr((c.periodAgg.spend || 0) / c.periodResults, 2)}` : ''}
                              </p>
                            </div>
                            <span className="text-right text-xs tabular-nums text-muted-foreground">
                              <span className="block font-semibold text-foreground">{inr(c.periodAgg.spend || 0)}</span>30 days
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              )}

              {access.social && (
                <Panel title="Coming up" icon={CalendarDays}
                  action={<TabLink onClick={() => selectTab('content')}>All content</TabLink>}>
                  {(() => {
                    const upcoming = hub.planItems.filter(i => (i.scheduled_date ?? '') >= today).slice(0, 5)
                    if (upcoming.length === 0) {
                      return <EmptyHint text={hub.currentPlan ? 'Nothing planned for the next three weeks.' : `No content plan for ${monthLabel(monthStartISO(today))}.`}
                        cta={{ href: planHref, label: hub.currentPlan ? 'Open plan' : 'Plan content' }} />
                    }
                    return (
                      <ul className="space-y-2.5">
                        {upcoming.map(i => {
                          const p = resolveItemProgress(i.status, i.request, i.task)
                          return (
                            <li key={i.id} className="flex items-center gap-3">
                              <DateBadge iso={i.scheduled_date} />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{i.title || 'Untitled post'}</p>
                                <p className="truncate text-xs capitalize text-muted-foreground">{(i.content_type ?? 'post').replace(/_/g, ' ')}</p>
                              </div>
                              <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${PROGRESS_CHIP[p]}`}>{PROGRESS_LABEL[p]}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )
                  })()}
                </Panel>
              )}

              {access.leads && (
                <Panel title="Latest leads" icon={UserPlus}
                  action={<TabLink onClick={() => selectTab('leads')}>All leads</TabLink>}>
                  {hub.leads.length === 0 ? (
                    <EmptyHint text="No leads yet. Leads from Meta lead forms appear here automatically." />
                  ) : (
                    <ul className="space-y-2.5">
                      {hub.leads.slice(0, 5).map(l => (
                        <li key={l.id} className="flex items-center gap-3">
                          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
                            {(l.full_name ?? '?').slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{l.full_name || l.phone || 'Unnamed lead'}</p>
                            <p className="truncate text-xs text-muted-foreground">{l.campaign_name || l.form_name || l.source || 'Direct'}</p>
                          </div>
                          <span className="shrink-0 text-xs capitalize text-muted-foreground">{l.status}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              )}
            </div>
          </div>
        )}

        {tab === 'pages' && (
          <PagesTab client={client} clients={clients} hub={hub} access={access} />
        )}

        {tab === 'ads' && ads && (
          <ClientWorkspace client={{ id: client.id, name: client.name, code: client.code ?? '' }} embedded tabKey="ads" {...ads} />
        )}

        {tab === 'content' && (
          <ContentTab client={client} hub={hub} access={access} today={today} />
        )}

        {tab === 'leads' && (
          <LeadsTab client={client} hub={hub} access={access} />
        )}
      </div>
    </>
  )
}

function TabLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
      {children} <ArrowRight className="h-3 w-3" />
    </button>
  )
}
