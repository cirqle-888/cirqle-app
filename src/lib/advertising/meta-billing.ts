/**
 * Meta billing sync (server-only) — keeps the ad-funds picture current:
 *
 *   1. Account snapshot   act_X?fields=amount_spent,funding_source_details,…
 *                          → ad_accounts.billing_* (available prepaid balance)
 *   2. Funding events     act_X/activities (funding_event_initiated /
 *                          _successful, billing charges, refunds…)
 *                          → ad_funding_events
 *   3. Campaign spend     act_X/insights?level=campaign&time_increment=1
 *                          → ad_campaign_daily_spend (EVERY campaign, mapped
 *                          or not — un-mapped spend is un-billable spend)
 *   4. Reconcile          link successful funding events to the Cashbook
 *                          top-ups that recorded them; suggest a client for
 *                          the ones nobody recorded.
 *
 * Needs the ads_read scope (already in META_OAUTH_SCOPES). Never throws:
 * failures land on ad_accounts.billing_sync_error so the UI can show them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { metaGraph, metaGraphAll } from '@/lib/integrations/meta/client'
import { decryptToken } from '@/lib/integrations/tokens'
import { todayISO, addDaysISO } from '@/lib/utils/local-date'
import {
  classifyFundingEvent, parseFundingAmount, parseAvailableBalance, parseMoney,
  matchFundingEvents, suggestClients, type FundingEventLite, type SpendLite,
} from './funds-core'
import {
  one, asRows, asRow, num, errorMessage,
  type AdAccountRow, type AdProjectLite, type AdCampaignRegistryRow, type FundingEventRow,
  type TopUpEntryRow, type CampaignSpendRow,
} from './funds-rows'

export interface BillingSyncResult {
  ok: boolean
  events: number
  spendRows: number
  matched: number
  error?: string
}

interface MetaSnapshot {
  currency?: string
  amount_spent?: string | number
  is_prepay_account?: boolean
  funding_source_details?: { display_string?: string }
}
interface MetaActivity {
  event_type?: string
  event_time?: string
  extra_data?: unknown
  object_id?: string
  translated_event_type?: string
}
interface MetaInsight {
  campaign_id?: string
  campaign_name?: string
  spend?: string
  impressions?: string
  date_start?: string
}

/** First sync looks this far back; later syncs re-read a short overlap. */
const BACKFILL_DAYS = 180
const OVERLAP_DAYS = 3

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000)

export async function syncAccountBilling(
  admin: SupabaseClient, accountRowId: string, opts: { backfillDays?: number } = {},
): Promise<BillingSyncResult> {
  const fail = async (error: string): Promise<BillingSyncResult> => {
    await admin.from('ad_accounts').update({ billing_sync_error: error.slice(0, 500) })
      .eq('id', accountRowId).then(null, () => {})
    return { ok: false, events: 0, spendRows: 0, matched: 0, error }
  }

  const { data, error: accErr } = await admin
    .from('ad_accounts')
    .select('id, name, provider, account_id, currency, billing_synced_at, connection:provider_connections ( access_token, status )')
    .eq('id', accountRowId).maybeSingle()
  if (accErr) return fail(accErr.message)
  const account = asRow<AdAccountRow>(data)
  if (!account) return fail('Ad account not found')
  if (account.provider !== 'meta') return { ok: true, events: 0, spendRows: 0, matched: 0 }

  const conn = one(account.connection)
  const token = decryptToken(conn?.access_token)
  if (!token || conn?.status !== 'active') return fail('No active Meta connection — reconnect in Advertising › Ad Accounts.')

  const act = account.account_id.startsWith('act_') ? account.account_id : `act_${account.account_id}`
  const today = todayISO()
  const sinceDay = account.billing_synced_at
    ? addDaysISO(account.billing_synced_at.slice(0, 10), -OVERLAP_DAYS)
    : addDaysISO(today, -(opts.backfillDays ?? BACKFILL_DAYS))
  const currency = (s: MetaSnapshot) => s.currency ?? account.currency ?? null

  try {
    // 1 ── Account snapshot ────────────────────────────────────────────────
    const snap = await metaGraph<MetaSnapshot>(act, {
      token,
      params: { fields: 'currency,amount_spent,is_prepay_account,funding_source_details' },
    })
    const display = snap.funding_source_details?.display_string ?? null
    // amount_spent is returned in the currency's minor unit (paise).
    const amountSpent = snap.amount_spent != null ? Math.round(Number(snap.amount_spent)) / 100 : null

    // 2 ── Funding / billing events ───────────────────────────────────────
    // Events always re-read the full backfill window (cheap, money events are
    // few): a re-sync then overwrites every stored row, so a parsing fix heals
    // old rows instead of only new ones. Spend below stays incremental.
    const eventsSince = addDaysISO(today, -(opts.backfillDays ?? BACKFILL_DAYS))
    const activities = await metaGraphAll<MetaActivity>(`${act}/activities`, {
      token,
      params: {
        fields: 'event_type,event_time,extra_data,object_id,translated_event_type',
        since: unix(`${eventsSince}T00:00:00Z`),
        until: unix(new Date().toISOString()) + 60,
        limit: 200,
      },
      maxPages: 20,
    })
    const eventRows = activities.flatMap(a => {
      const status = classifyFundingEvent(a.event_type)
      if (!status || !a.event_time) return []
      const parsed = parseFundingAmount(a.extra_data, currency(snap))
      let extra: unknown = a.extra_data ?? null
      if (typeof extra === 'string') { try { extra = JSON.parse(extra) } catch { extra = { raw: extra } } }
      const extraObj = extra && typeof extra === 'object' ? extra as Record<string, unknown> : { value: extra }
      return [{
        ad_account_id: accountRowId,
        event_key: `${a.event_type}|${a.event_time}|${a.object_id ?? ''}`,
        event_type: a.event_type,
        status,
        amount: parsed.amount,
        currency: parsed.currency ?? currency(snap),
        event_time: new Date(a.event_time).toISOString(),
        extra_data: { ...extraObj, translated: a.translated_event_type ?? null },
        updated_at: new Date().toISOString(),
      }]
    })
    if (eventRows.length) {
      // Only provider-side columns are written, so a manual match / dismissal
      // made in the app is never overwritten by a re-sync.
      const { error } = await admin.from('ad_funding_events')
        .upsert(eventRows, { onConflict: 'ad_account_id,event_key' })
      if (error) throw new Error(`Saving funding events: ${error.message}`)
    }

    // 3 ── Daily spend per campaign ───────────────────────────────────────
    const insights = await metaGraphAll<MetaInsight>(`${act}/insights`, {
      token,
      params: {
        level: 'campaign',
        time_increment: 1,
        fields: 'campaign_id,campaign_name,spend,impressions',
        time_range: { since: sinceDay, until: today },
        limit: 500,
      },
      maxPages: 50,
    })
    const spendRows = insights
      .filter(r => r.campaign_id && r.date_start)
      .map(r => ({
        ad_account_id: accountRowId,
        external_campaign_id: String(r.campaign_id),
        campaign_name: r.campaign_name ?? null,
        spend_date: r.date_start as string,
        spend: parseMoney(r.spend) ?? 0,
        currency: currency(snap),
        impressions: r.impressions != null ? Number(r.impressions) : null,
        updated_at: new Date().toISOString(),
      }))
    for (let i = 0; i < spendRows.length; i += 500) {
      const { error } = await admin.from('ad_campaign_daily_spend')
        .upsert(spendRows.slice(i, i + 500), { onConflict: 'ad_account_id,external_campaign_id,spend_date' })
      if (error) throw new Error(`Saving campaign spend: ${error.message}`)
    }

    // 4 ── Snapshot + reconcile ───────────────────────────────────────────
    await admin.from('ad_accounts').update({
      billing_available_balance: parseAvailableBalance(display),
      billing_amount_spent: amountSpent,
      billing_funding_display: display,
      billing_is_prepay: snap.is_prepay_account ?? null,
      billing_synced_at: new Date().toISOString(),
      billing_sync_error: null,
    }).eq('id', accountRowId)

    const matched = await reconcileAccountFunding(admin, accountRowId)
    return { ok: true, events: eventRows.length, spendRows: spendRows.length, matched }
  } catch (err) {
    return fail(errorMessage(err, 'Billing sync failed'))
  }
}

export type CampaignOwners = Map<string, { clientId: string | null; projectId: string | null }>

/**
 * `${adAccountId}:${externalCampaignId}` → client/project. Mapping comes from
 * the discovery registry (ad_campaigns) and, as a fallback, from ad projects
 * that carry the campaign id in provider_metadata.
 */
export async function loadCampaignOwners(admin: SupabaseClient, accountIds: string[]): Promise<CampaignOwners> {
  const out: CampaignOwners = new Map()
  if (!accountIds.length) return out
  const [projectsRes, campsRes] = await Promise.all([
    admin.from('ad_projects').select('id, campaign_name, client_id, ad_account_id, status, scope, provider_metadata')
      .in('ad_account_id', accountIds).is('deleted_at', null),
    admin.from('ad_campaigns').select('ad_account_id, external_campaign_id, client_id, project_id')
      .in('ad_account_id', accountIds),
  ])
  const projClient = new Map<string, string | null>()
  for (const p of asRows<AdProjectLite>(projectsRes.data)) {
    projClient.set(p.id, p.client_id ?? null)
    const cid = p.provider_metadata?.campaign_id
    if (cid != null && p.ad_account_id) out.set(`${p.ad_account_id}:${cid}`, { clientId: p.client_id ?? null, projectId: p.id })
  }
  for (const c of asRows<AdCampaignRegistryRow>(campsRes.data)) {
    const k = `${c.ad_account_id}:${c.external_campaign_id}`
    const prev = out.get(k)
    const projectId = c.project_id ?? prev?.projectId ?? null
    const clientId = c.client_id ?? (projectId ? projClient.get(projectId) ?? null : null) ?? prev?.clientId ?? null
    out.set(k, { clientId, projectId })
  }
  return out
}

/**
 * Link successful funding events ↔ Cashbook top-ups, and pre-compute a client
 * suggestion for every successful event nobody recorded yet. Returns the
 * number of new links. Never throws.
 */
export async function reconcileAccountFunding(admin: SupabaseClient, accountRowId: string): Promise<number> {
  try {
    const since = addDaysISO(todayISO(), -400)
    const [evRes, entryRes] = await Promise.all([
      admin.from('ad_funding_events')
        .select('id, ad_account_id, status, amount, event_time, cashbook_entry_id, suggested_client_id, dismissed_at')
        .eq('ad_account_id', accountRowId).gte('event_time', `${since}T00:00:00Z`),
      admin.from('cashbook_entries')
        .select('id, ad_account_id, amount, amount_inr, entry_date')
        .eq('ad_account_id', accountRowId).eq('type', 'outflow').is('deleted_at', null)
        .gte('entry_date', since),
    ])
    const evRows = asRows<FundingEventRow>(evRes.data)
    const events: FundingEventLite[] = evRows.map(e => ({
      id: e.id, adAccountId: e.ad_account_id, status: e.status, amount: e.amount != null ? num(e.amount) : null,
      eventTime: e.event_time, cashbookEntryId: e.cashbook_entry_id, dismissedAt: e.dismissed_at,
    }))
    const links = matchFundingEvents(events, asRows<TopUpEntryRow>(entryRes.data).map(e => ({
      id: e.id, adAccountId: e.ad_account_id, amount: num(e.amount ?? e.amount_inr), entryDate: e.entry_date,
    })))
    const now = new Date().toISOString()
    for (const [eventId, entryId] of links) {
      await admin.from('ad_funding_events')
        .update({ cashbook_entry_id: entryId, matched_at: now, updated_at: now })
        .eq('id', eventId).is('cashbook_entry_id', null)
    }

    // Client suggestions for the still-unrecorded successful top-ups.
    const open = evRows.filter(e =>
      e.status === 'successful' && !e.cashbook_entry_id && !links.has(e.id) && !e.dismissed_at && !e.suggested_client_id)
    if (open.length) {
      const owners = await loadCampaignOwners(admin, [accountRowId])
      const minDay = addDaysISO(open.map(e => e.event_time.slice(0, 10)).sort()[0], -3)
      const { data: spend } = await admin.from('ad_campaign_daily_spend')
        .select('external_campaign_id, spend_date, spend')
        .eq('ad_account_id', accountRowId).gte('spend_date', minDay)
      const rows: SpendLite[] = asRows<CampaignSpendRow>(spend).map(s => ({
        adAccountId: accountRowId,
        clientId: owners.get(`${accountRowId}:${s.external_campaign_id}`)?.clientId ?? null,
        date: s.spend_date,
        spendExGst: num(s.spend),
      }))
      for (const e of open) {
        const [best] = suggestClients(rows, accountRowId, e.event_time)
        if (best) await admin.from('ad_funding_events').update({ suggested_client_id: best }).eq('id', e.id)
      }
    }
    return links.size
  } catch {
    return 0
  }
}
