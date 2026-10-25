/**
 * "Needs attention" — the short list of things someone should act on today.
 *
 * Built from data the advertising overview already loads; pure so the rules
 * are unit-tested. Every item says what is wrong (reason), who owns it, and
 * the one action that resolves it, with a link to where that happens. Items
 * have a stable `key` per condition per day-ish window, so a snoozed item
 * stays hidden until the snooze expires and a NEW occurrence shows again.
 */

import { addDaysISO } from '@/lib/utils/local-date'

export type AttentionSeverity = 'critical' | 'warning' | 'info'

export interface AttentionItem {
  key: string
  severity: AttentionSeverity
  title: string
  reason: string
  action: string
  href: string
  clientName?: string | null
  campaignName?: string | null
  owner?: string | null
}

export interface AttentionCampaign {
  id: string
  name: string
  clientName: string | null
  owner: string | null
  status: string
  archived: boolean
  syncEnabled: boolean
  syncStatus: string | null
  lastSyncAt: string | null
  lastSyncError: string | null
  hasAdAccount: boolean
  endDate: string | null
  /** metric_date → spend, for the last few days. */
  recentSpendByDate: Record<string, number>
  /** Allocation minus GST-inclusive spend (null = no allocation recorded). */
  unspentAllocation: number | null
  /** Funds allocated to the campaign (null = wallets not in use / hidden). */
  allocated?: number | null
  /** Lifetime spend incl. GST. */
  spendInclGst?: number
}

export interface AttentionConnection {
  id: string
  name: string
  status: string
  tokenExpiresAt: string | null
}

export interface AttentionReport {
  id: string
  campaignName: string | null
  status: string
  createdAt: string
  errorMessage: string | null
}

export interface AttentionInput {
  today: string          // business-calendar YYYY-MM-DD
  now: Date
  campaigns: AttentionCampaign[]
  connections: AttentionConnection[]
  failedReports: AttentionReport[]
  failedEmails: { reportId: string; recipient: string; at: string }[]
}

/** Hours after which an auto-synced campaign's data counts as stale. */
export const STALE_SYNC_HOURS = 48
const EXPIRY_WARN_DAYS = 7
const ENDING_SOON_DAYS = 3

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 }

export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = []
  const { now, today } = input
  const hoursSince = (iso: string | null) => (iso ? (now.getTime() - new Date(iso).getTime()) / 3_600_000 : Infinity)

  for (const c of input.connections) {
    const href = '/dashboard/connections'
    if (c.status !== 'active') {
      items.push({
        key: `conn-inactive:${c.id}`, severity: 'critical', href,
        title: `Ad account connection "${c.name}" is ${c.status}`,
        reason: 'Campaigns on this connection cannot sync, so reports will miss data.',
        action: 'Reconnect the account',
      })
      continue
    }
    if (c.tokenExpiresAt) {
      const days = (new Date(c.tokenExpiresAt).getTime() - now.getTime()) / 86_400_000
      if (days < EXPIRY_WARN_DAYS) {
        items.push({
          key: `conn-expiry:${c.id}`, severity: days < 0 ? 'critical' : 'warning', href,
          title: days < 0 ? `"${c.name}" access has expired` : `"${c.name}" access expires in ${Math.max(0, Math.ceil(days))} day${Math.ceil(days) === 1 ? '' : 's'}`,
          reason: 'When the token expires, syncing stops for every campaign on it.',
          action: 'Reconnect to refresh access',
        })
      }
    }
  }

  for (const c of input.campaigns) {
    if (c.archived) continue
    const active = c.status === 'active'
    const href = `/dashboard/advertising/${c.id}`
    const base = { clientName: c.clientName, campaignName: c.name, owner: c.owner, href }

    if (c.syncEnabled && c.hasAdAccount && (c.syncStatus === 'error' || c.lastSyncError)) {
      items.push({
        ...base, key: `sync-error:${c.id}`, severity: 'critical',
        title: 'Sync failed',
        reason: (c.lastSyncError ?? 'The last sync reported an error.').slice(0, 160),
        action: 'Open Integrations and run Sync Now',
      })
    } else if (active && c.syncEnabled && c.hasAdAccount && hoursSince(c.lastSyncAt) > STALE_SYNC_HOURS) {
      items.push({
        ...base, key: `sync-stale:${c.id}`, severity: 'warning',
        title: c.lastSyncAt ? 'Data is out of date' : 'Never synced',
        reason: c.lastSyncAt
          ? `Last synced ${Math.floor(hoursSince(c.lastSyncAt) / 24)} days ago — numbers and reports are behind.`
          : 'No data has been pulled from the ad platform yet.',
        action: 'Run Sync Now',
      })
    }

    if (c.allocated === 0 && (c.spendInclGst ?? 0) > 0) {
      items.push({
        ...base, key: `unfunded:${c.id}`, severity: 'warning',
        title: 'Spending with no funds allocated',
        reason: `₹${Math.round(c.spendInclGst ?? 0).toLocaleString('en-IN')} spent incl. GST, but nothing is allocated to this campaign from the client wallet.`,
        action: 'Allocate funds to the campaign',
        href: `${href}?tab=funds`,
      })
    } else if (c.unspentAllocation != null && c.unspentAllocation < 0) {
      items.push({
        ...base, key: `overspent:${c.id}`, severity: 'critical',
        title: 'Spend is above the allocated funds',
        reason: `Spend incl. GST is ₹${Math.abs(Math.round(c.unspentAllocation)).toLocaleString('en-IN')} more than allocated to this campaign.`,
        action: 'Allocate funds or pause the campaign',
        href: `${href}?tab=funds`,
      })
    }

    if (active && c.syncEnabled && c.hasAdAccount && hoursSince(c.lastSyncAt) <= STALE_SYNC_HOURS) {
      const y1 = addDaysISO(today, -1), y2 = addDaysISO(today, -2)
      const recorded = [y1, y2].filter(d => d in c.recentSpendByDate)
      if (recorded.length === 2 && recorded.every(d => !(c.recentSpendByDate[d] > 0))) {
        items.push({
          ...base, key: `zero-spend:${c.id}:${y1}`, severity: 'warning',
          title: 'Active but not spending',
          reason: 'No spend on the last two days although the campaign is marked active — check payment, approval or delivery in Ads Manager.',
          action: 'Check delivery in Ads Manager',
        })
      }
    }

    if (active && c.endDate && c.endDate >= today && c.endDate <= addDaysISO(today, ENDING_SOON_DAYS)) {
      items.push({
        ...base, key: `ending:${c.id}:${c.endDate}`, severity: 'info',
        title: c.endDate === today ? 'Ends today' : `Ends ${c.endDate}`,
        reason: 'Plan the wrap-up report and whether to extend.',
        action: 'Prepare the end-of-campaign report',
        href: `${href}?tab=reports`,
      })
    }
  }

  for (const r of input.failedReports) {
    items.push({
      key: `report-failed:${r.id}`, severity: 'warning',
      title: 'Report generation failed',
      reason: (r.errorMessage ?? 'The report could not be produced.').slice(0, 160),
      action: 'Open the report and retry',
      href: `/dashboard/advertising/reports/${r.id}`,
      campaignName: r.campaignName,
    })
  }

  for (const e of input.failedEmails) {
    items.push({
      key: `email-failed:${e.reportId}:${e.recipient}`, severity: 'warning',
      title: 'Report email was not sent',
      reason: `Delivery to ${e.recipient} failed.`,
      action: 'Check the address and resend',
      href: `/dashboard/advertising/reports/${e.reportId}`,
    })
  }

  // De-duplicate by key, most severe first, stable within a severity.
  const seen = new Set<string>()
  return items
    .filter(i => (seen.has(i.key) ? false : (seen.add(i.key), true)))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/** Drop items whose key is snoozed until after `now`. */
export function withoutSnoozed(items: AttentionItem[], snoozedUntil: Record<string, string>, now: Date): AttentionItem[] {
  return items.filter(i => {
    const until = snoozedUntil[i.key]
    return !until || new Date(until).getTime() <= now.getTime()
  })
}
