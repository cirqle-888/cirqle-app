/**
 * Client Marketing Hub — the rules behind "pick a client, see everything".
 *
 * Pure (no DB, no React) so the thresholds and wording are unit-tested and
 * read the same on the client list and inside a client's hub. The loaders in
 * ./load.ts fetch the rows; these functions turn them into what the screens
 * say.
 */

import { assessHealth, type HealthState } from '@/lib/assets/health'
import { resolveItemProgress, type ItemProgress, type LinkedRequestView, type LinkedTaskView } from '@/lib/social/plan'
import type { AttentionItem } from '@/lib/advertising/attention'

// ── Content plan progress ───────────────────────────────────────────────────

export interface PlanItemLike {
  status: string
  scheduled_date?: string | null
  request?: LinkedRequestView | null
  task?: LinkedTaskView | null
}

export interface PlanProgress {
  /** Items that count toward the plan (cancelled ones do not). */
  total: number
  done: number
  counts: Record<ItemProgress, number>
  /** 0–100, done ÷ total; 0 when the plan is empty. */
  pct: number
}

export const PROGRESS_ORDER: ItemProgress[] = ['done', 'delivered', 'in_progress', 'requested', 'planned']

/** One plan's items → counts per state, the same states the Social Calendar shows. */
export function planProgress(items: PlanItemLike[]): PlanProgress {
  const counts: Record<ItemProgress, number> = {
    planned: 0, requested: 0, in_progress: 0, delivered: 0, done: 0, cancelled: 0,
  }
  for (const it of items) counts[resolveItemProgress(it.status, it.request, it.task)] += 1
  const total = items.length - counts.cancelled
  return { total, done: counts.done, counts, pct: total > 0 ? Math.round((counts.done / total) * 100) : 0 }
}

/** 'YYYY-MM-01' for the month containing an ISO date — social_calendars.month's format. */
export function monthStartISO(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`
}

/** "October 2026" from 'YYYY-MM-01'. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return month
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// ── Pages & accounts ────────────────────────────────────────────────────────

export interface HubAccountLike {
  id: string
  platform: string
  name: string
  status: string | null
  last_synced_at: string | null
  last_error?: string | null
}

/**
 * One verdict per Page / Instagram account, from the shared asset-health rule
 * so this screen and Connections never disagree. A brand-new account that has
 * never synced is not "broken" — it is waiting for its first sync — so it reads
 * amber with that reason rather than red.
 */
export function accountHealth(a: HubAccountLike, nowIso?: string): { state: HealthState; reason: string | null } {
  const v = assessHealth({ status: a.status, lastSyncedAt: a.last_synced_at, lastError: a.last_error ?? null, now: nowIso })
  if (!a.last_synced_at && v.state !== 'red') return { state: 'amber', reason: 'Waiting for its first sync' }
  return { state: v.state, reason: v.reasons[0] ?? null }
}

/** Where the account lives on Meta — for "Open on Facebook / Instagram". */
export function socialProfileUrl(platform: string, externalId: string | null, username: string | null): string | null {
  if (platform === 'instagram') return username ? `https://www.instagram.com/${username}/` : null
  if (platform === 'facebook_page') return externalId ? `https://www.facebook.com/${externalId}` : null
  return null
}

/** Ads Manager, opened on one ad account. */
export function adsManagerUrl(accountId: string): string {
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${accountId.replace(/^act_/, '')}`
}

// ── Needs attention ─────────────────────────────────────────────────────────

export interface HubIssueInput {
  clientId: string
  clientName: string
  accounts: HubAccountLike[]
  /** This month's plan, if one exists. */
  currentPlan: { id: string; progress: PlanProgress } | null
  /**
   * Does this client do social work at all (has a Page or has ever had a
   * plan)? An ads-only client is not missing a content plan.
   */
  expectsPlan: boolean
  /** Plan items dated before today that are not finished. */
  overduePlanItems: number
  failedPosts: number
  /** Leads still in 'new' after a day. */
  staleNewLeads: number
  canSeeSocial: boolean
  canSeeLeads: boolean
  today: string
  nowIso?: string
}

/**
 * Social, content and lead issues for one client, in the advertising
 * attention shape so one panel lists them beside the campaign issues. Each
 * item names the fix and links to where it happens.
 */
export function hubIssues(i: HubIssueInput): AttentionItem[] {
  const out: AttentionItem[] = []
  const hub = `/dashboard/marketing/${i.clientId}`

  if (i.canSeeSocial) {
    for (const a of i.accounts) {
      const h = accountHealth(a, i.nowIso)
      if (h.state === 'green') continue
      // Never-synced is expected right after connecting; not worth a row.
      if (!a.last_synced_at && h.state === 'amber') continue
      out.push({
        key: `acct:${a.id}:${h.state}`,
        severity: h.state === 'red' ? 'critical' : 'warning',
        title: h.state === 'red' ? `${a.name} needs reconnecting` : `${a.name} needs a look`,
        reason: h.reason ?? 'Check the account',
        action: h.state === 'red' ? 'Reconnect' : 'Open pages',
        href: h.state === 'red' ? '/dashboard/connections' : `${hub}?tab=pages`,
      })
    }

    if (!i.currentPlan && i.expectsPlan) {
      out.push({
        key: `plan:none:${i.today.slice(0, 7)}`,
        severity: 'info',
        title: `No content plan for ${monthLabel(monthStartISO(i.today))}`,
        reason: 'Plan this month’s posts so the work reaches Requests on time',
        action: 'Plan content',
        href: '/dashboard/social-calendar',
      })
    } else if (i.currentPlan && i.overduePlanItems > 0) {
      out.push({
        key: `plan:overdue:${i.currentPlan.id}:${i.today}`,
        severity: 'warning',
        title: i.overduePlanItems === 1 ? '1 planned post is past its date' : `${i.overduePlanItems} planned posts are past their date`,
        reason: 'Dated before today and not finished yet',
        action: 'Open plan',
        href: `/dashboard/social-calendar?calendar=${i.currentPlan.id}`,
      })
    }

    if (i.failedPosts > 0) {
      out.push({
        key: `posts:failed:${i.clientId}`,
        severity: 'critical',
        title: `${i.failedPosts} post${i.failedPosts === 1 ? '' : 's'} failed to publish`,
        reason: 'Meta rejected the publish — fix and retry',
        action: 'Review posts',
        href: '/dashboard/social/queue',
      })
    }
  }

  if (i.canSeeLeads && i.staleNewLeads > 0) {
    out.push({
      key: `leads:new:${i.clientId}:${i.today}`,
      severity: 'warning',
      title: `${i.staleNewLeads} lead${i.staleNewLeads === 1 ? '' : 's'} not contacted yet`,
      reason: 'Still marked New after a day',
      action: 'Open leads',
      href: `${hub}?tab=leads`,
    })
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// ── Client list ─────────────────────────────────────────────────────────────

/** Two letters for the client avatar. */
export function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

/** A stable hue per client so its avatar keeps its colour between visits. */
export function avatarHue(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

export interface DirectoryEntryLike {
  name: string
  code?: string | null
  pages: number
  liveCampaigns: number
  hasPlan: boolean
  leads30: number
}

/** Does this client have anything marketing-shaped yet? Drives "Active" vs "Not set up". */
export function hasMarketing(e: DirectoryEntryLike): boolean {
  return e.pages > 0 || e.liveCampaigns > 0 || e.hasPlan || e.leads30 > 0
}

/** Search across name and code, forgiving of case and spacing. */
export function matchesClient(client: { name: string; code?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = `${client.name} ${client.code ?? ''}`.toLowerCase()
  return q.split(/\s+/).every(part => hay.includes(part))
}
