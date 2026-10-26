'use client'

/**
 * Content tab — this client's month at a glance: the plan's progress, what is
 * coming up, what is waiting to go out, and what went out lately. Planning,
 * composing and replying still happen in the Social tools (one click away,
 * opened on this client where the tool supports it); this tab is where you see
 * the whole picture without hunting for it.
 */

import Link from 'next/link'
import {
  CalendarDays, Clock, ExternalLink, Eye, Grid3x3, MessageCircle, PenSquare, Send, Sparkles,
} from 'lucide-react'
import { PROGRESS_CHIP, PROGRESS_LABEL, resolveItemProgress, type ItemProgress } from '@/lib/social/plan'
import { monthLabel, monthStartISO, PROGRESS_ORDER } from '@/lib/marketing/hub'
import type { ClientMarketing } from '@/lib/marketing/load'
import type { MarketingAccess } from '../_access'
import { AccountAvatar, DateBadge, EmptyHint, Panel, compact, type HubClient } from '../_ui'

const BAR: Record<ItemProgress, string> = {
  done: 'bg-emerald-500', delivered: 'bg-purple-500', in_progress: 'bg-amber-500',
  requested: 'bg-blue-500', planned: 'bg-gray-400', cancelled: 'bg-red-400',
}

export default function ContentTab({ client, hub, access, today }: {
  client: HubClient
  hub: ClientMarketing
  access: MarketingAccess
  today: string
}) {
  const plan = hub.currentPlan
  const thisMonth = monthStartISO(today)
  const accountById = new Map(hub.accounts.map(a => [a.id, a]))
  const upcoming = hub.planItems.filter(i => (i.scheduled_date ?? '') >= today)
  // The same count the Overview's "Needs attention" uses — this month's plan.
  const overdue = hub.overduePlanItems

  const tools = [
    { href: plan ? `/dashboard/social-calendar?calendar=${plan.id}` : '/dashboard/social-calendar', label: 'Plan', icon: CalendarDays, show: access.social },
    { href: '/dashboard/social/queue', label: 'To post', icon: Send, show: access.socialPublish },
    { href: `/dashboard/social/calendar?client=${client.id}`, label: 'Compose', icon: PenSquare, show: access.socialPublish },
    { href: '/dashboard/social/inbox', label: 'Comments', icon: MessageCircle, show: access.socialPublish },
    { href: '/dashboard/social/times', label: 'Best times', icon: Clock, show: access.social },
  ].filter(t => t.show)
  const igAccount = hub.accounts.find(a => a.platform === 'instagram')

  return (
    <div className="space-y-5">
      {/* This month's plan */}
      <section className="rounded-2xl border border-border bg-gradient-to-br from-violet-500/[0.06] via-card to-pink-500/[0.06] p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Content plan · {monthLabel(thisMonth)}</p>
            {plan ? (
              <h2 className="mt-1 text-2xl font-bold tabular-nums">
                {plan.progress.done}<span className="text-muted-foreground">/{plan.progress.total}</span>
                <span className="ml-2 text-sm font-medium text-muted-foreground">posts done · {plan.progress.pct}%</span>
              </h2>
            ) : (
              <h2 className="mt-1 text-lg font-semibold">No plan for this month yet</h2>
            )}
          </div>
          <Link href={plan ? `/dashboard/social-calendar?calendar=${plan.id}` : '/dashboard/social-calendar'}
            className="inline-flex items-center gap-1.5 self-start rounded-lg gradient-bg px-3 py-2 text-sm font-medium text-white hover:opacity-90">
            {plan ? <><CalendarDays className="h-4 w-4" /> Open plan</> : <><Sparkles className="h-4 w-4" /> Create this month’s plan</>}
          </Link>
        </div>

        {plan && plan.progress.total > 0 && (
          <>
            <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
              {PROGRESS_ORDER.map(k => plan.progress.counts[k] > 0 && (
                <div key={k} className={BAR[k]} style={{ width: `${(plan.progress.counts[k] / plan.progress.total) * 100}%` }} />
              ))}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {PROGRESS_ORDER.map(k => (
                <li key={k} className="inline-flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${BAR[k]}`} />
                  {PROGRESS_LABEL[k]} <span className="font-semibold tabular-nums text-foreground">{plan.progress.counts[k]}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {hub.plans.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border/60 pt-3">
            {hub.plans.filter(p => p.month !== thisMonth).slice(0, 6).map(p => (
              <Link key={p.id} href={`/dashboard/social-calendar?calendar=${p.id}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs hover:border-primary/40">
                {monthLabel(p.month)} <span className="tabular-nums text-muted-foreground">{p.progress.pct}%</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Tools, opened on this client */}
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tools.map(t => {
            const Icon = t.icon
            return (
              <Link key={t.label} href={t.href}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition hover:border-primary/40">
                <Icon className="h-4 w-4 text-muted-foreground" /> {t.label}
              </Link>
            )
          })}
          {igAccount && (
            <Link href={`/dashboard/social/feed?account=${igAccount.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium transition hover:border-primary/40">
              <Grid3x3 className="h-4 w-4 text-muted-foreground" /> Feed grid
            </Link>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Next three weeks" icon={CalendarDays}>
          {overdue > 0 && plan && (
            <Link href={`/dashboard/social-calendar?calendar=${plan.id}`}
              className="mb-3 block rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 hover:bg-amber-500/15 dark:text-amber-400">
              {overdue === 1 ? '1 post this month is past its date and not finished' : `${overdue} posts this month are past their date and not finished`} — open the plan →
            </Link>
          )}
          {upcoming.length === 0 ? (
            <EmptyHint text="Nothing planned in the next three weeks." />
          ) : (
            <ul className="space-y-2.5">
              {upcoming.slice(0, 12).map(i => {
                const p = resolveItemProgress(i.status, i.request, i.task)
                return (
                  <li key={i.id}>
                    <Link href={`/dashboard/social-calendar?calendar=${i.calendar_id}`} className="group flex items-center gap-3">
                      <DateBadge iso={i.scheduled_date} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium group-hover:text-primary">{i.title || 'Untitled post'}</p>
                        <p className="truncate text-xs capitalize text-muted-foreground">
                          {(i.content_type ?? 'post').replace(/_/g, ' ')}
                          {i.platforms?.length ? ` · ${i.platforms.join(', ').replace(/_/g, ' ')}` : ''}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${PROGRESS_CHIP[p]}`}>{PROGRESS_LABEL[p]}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Waiting to go out" icon={Send}
          action={access.socialPublish ? <Link href="/dashboard/social/queue" className="text-xs font-medium text-primary hover:underline">To post →</Link> : undefined}>
          {hub.scheduledPosts.length === 0 && hub.failedPosts === 0 ? (
            <EmptyHint text="No posts scheduled or awaiting approval."
              cta={access.socialPublish && hub.accounts.length > 0 ? { href: `/dashboard/social/calendar?client=${client.id}`, label: 'Compose a post' } : undefined} />
          ) : (
            <ul className="space-y-2.5">
              {hub.failedPosts > 0 && (
                <li className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                  {hub.failedPosts} post{hub.failedPosts === 1 ? '' : 's'} failed to publish — open To post to retry.
                </li>
              )}
              {hub.scheduledPosts.slice(0, 8).map(p => {
                const acct = p.account_id ? accountById.get(p.account_id) : undefined
                return (
                  <li key={p.id} className="flex items-center gap-3">
                    {p.cover_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.cover_url} alt="" className="h-10 w-10 shrink-0 rounded-lg object-cover" />
                    ) : acct ? <AccountAvatar url={acct.profile_picture_url} platform={acct.platform} size={40} /> : <DateBadge iso={null} />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{p.caption?.trim() || 'No caption yet'}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.status === 'scheduled' ? 'Scheduled' : p.status === 'pending_approval' ? 'Awaiting approval' : 'Approved'}
                        {p.scheduled_at && ` · ${new Date(p.scheduled_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Published in the last 30 days" icon={Eye}
        action={<span className="text-xs text-muted-foreground">{hub.recentMedia.length} post{hub.recentMedia.length === 1 ? '' : 's'}</span>}>
        {hub.recentMedia.length === 0 ? (
          <EmptyHint text="Nothing published in the last 30 days (or the accounts have not synced yet)." />
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {hub.recentMedia.slice(0, 18).map(m => {
              const img = m.thumbnail_url || m.media_url
              return (
                <a key={m.id} href={m.permalink ?? undefined} target="_blank" rel="noopener noreferrer"
                  title={m.caption ?? undefined}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-secondary">
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt="" loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
                  ) : (
                    <span className="flex h-full items-center justify-center p-2 text-center text-[11px] text-muted-foreground line-clamp-4">{m.caption || 'Post'}</span>
                  )}
                  <span className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-4 text-[11px] font-medium text-white">
                    <span className="inline-flex items-center gap-0.5"><Eye className="h-3 w-3" />{compact(m.reach ?? m.views)}</span>
                    <ExternalLink className="h-3 w-3 opacity-0 transition group-hover:opacity-100" />
                  </span>
                </a>
              )
            })}
          </div>
        )}
      </Panel>
    </div>
  )
}
