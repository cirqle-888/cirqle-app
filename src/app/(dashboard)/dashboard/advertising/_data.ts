/**
 * Advertising data loader — shared by the overview (all clients) and the
 * client workspace (one client). Defensive by design (mirrors
 * requests/page.tsx): if the ad_* tables haven't been migrated yet,
 * `migrated` flips false and the UI shows a one-time notice instead of
 * crashing. Every query that carries confidential layers is gated HERE, at
 * the query, so gated data never reaches the browser.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { getBenchmarksForProjects, type BenchmarkResult } from '@/lib/advertising/ai/benchmarks'
import type { AttentionData } from './advertising-client'

export interface AdvertisingData {
  migrated: boolean
  projects: any[]
  clients: { id: string; name: string; code: string }[]
  ledger: any[]
  walletSupported: boolean
  metricsByProject: Record<string, any[]>
  benchmarksByProject: Record<string, BenchmarkResult>
  attention: AttentionData
  fundCandidates: any[]
  pendingRequests: any[]
}

export async function loadAdvertisingData(opts: {
  /** Restrict everything to one client (the client workspace). */
  clientId?: string
  viewFinancials: boolean
  viewBilling: boolean
}): Promise<AdvertisingData> {
  const { clientId, viewFinancials, viewBilling } = opts
  const admin = createAdminClient()

  // These four are INDEPENDENT, so they go out together rather than one after
  // another. Only `metrics` (needs project ids) and `fundCandidates` (needs to
  // know the wallet exists) genuinely have to wait, and they still do below.
  const projectsP = (async () => {
    try {
      let q = admin
        .from('ad_projects')
        .select('*, client:clients(id, name, code)')
        .is('deleted_at', null)
      if (clientId) q = q.eq('client_id', clientId)
      const { data, error } = await q
        .order('created_at', { ascending: false })
        .limit(500)
      return { rows: data || [], migrated: !error }
    } catch { return { rows: [] as any[], migrated: false } }
  })()

  const clientsP = (async () => {
    try { return (await admin.from('clients').select('id, name, code').order('name')).data || [] }
    catch { return [] as any[] }
  })()

  // ── Client wallet ledger (best-effort — migration 20260703140000) ──────────
  // One fetch powers balances, per-campaign allocations, and the history panel.
  // FINANCIALS-GATED at the QUERY: without view_financials only DEBIT rows
  // (campaign allocations = working budgets, visible to every viewer) are
  // fetched — credits/top-ups, and therefore wallet balances, never reach the
  // browser at all.
  const ledgerP = (async () => {
    try {
      let q = admin
        .from('ad_wallet_ledger')
        .select(`
          id, client_id, direction, kind, ad_project_id, cashbook_entry_id,
          amount, amount_inr, notes, created_at,
          creator:employees(id, name, cqid),
          entry:cashbook_entries(id, entry_date, description, reference),
          project:ad_projects(id, campaign_name)
        `)
        .is('deleted_at', null)
      if (!viewFinancials) q = q.eq('direction', 'debit')
      if (clientId) q = q.eq('client_id', clientId)
      const { data, error } = await q.order('created_at', { ascending: false }).limit(1000)
      return { rows: data || [], supported: !error }
    } catch { return { rows: [] as any[], supported: false } }
  })()

  // Advertising requests waiting to be started (they also show in the Requests
  // inbox). Defensive: the ad_meta column ships in a later migration.
  const pendingRequestsP = (async () => {
    if (clientId) return [] as any[] // the workspace has no request inbox
    try {
      const { data } = await admin
        .from('task_requests')
        .select('id, ref_no, title, created_at, ad_meta, client:clients(id, name)')
        .not('ad_meta', 'is', null)
        .is('promoted_task_id', null)
        .not('status', 'in', '("rejected","archived")')
        .order('created_at', { ascending: false })
        .limit(50)
      return data || []
    } catch { return [] as any[] }
  })()

  const [projectsRes, clients, ledgerRes, pendingRequests] =
    await Promise.all([projectsP, clientsP, ledgerP, pendingRequestsP])

  const projects: any[] = projectsRes.rows
  const migrated = projectsRes.migrated
  const ledger: any[] = ledgerRes.rows
  const walletSupported = ledgerRes.supported

  // Aggregate-able daily rows per project (defensive — table may be empty/missing).
  const metricsByProject: Record<string, any[]> = {}
  if (migrated && projects.length) {
    try {
      const ids = projects.map(p => p.id)
      const { data: metrics } = await admin
        .from('ad_daily_metrics')
        // Result counts (messages/purchases/conversions) and the FX rate are
        // needed for the shared health rules and base-currency spend.
        .select('project_id, spend, revenue, impressions, clicks, reach, leads, conversions, messages, purchases, exchange_rate_ad_to_base, metric_date')
        .in('project_id', ids)
      for (const m of metrics || []) (metricsByProject[(m as any).project_id] ||= []).push(m)
    } catch { /* metrics table not migrated */ }
  }

  // Report benchmark tiers, batched — health on the list uses the same rules
  // (and benchmarks) as the campaign page and reports. Best-effort.
  let benchmarksByProject: Record<string, BenchmarkResult> = {}
  if (migrated && projects.length) {
    benchmarksByProject = await getBenchmarksForProjects(projects.map(p => ({ id: p.id, client_id: p.client_id ?? null })))
      .catch(() => ({}))
  }


  // Needs-attention inputs. Each read is best-effort: a missing table or
  // column only removes that kind of alert, never the page.
  const attention = await loadAttentionInputs(admin, projects, migrated, clientId)

  // Candidate funding entries for "Add funds": recent outflows + how much of
  // each is still uncredited to any wallet. Wallet-layer data → gated.
  let fundCandidates: any[] = []
  if (walletSupported && viewFinancials) {
    try {
      const { data: outflows } = await admin
        .from('cashbook_entries')
        .select('id, entry_date, description, reference, amount, amount_inr, currency')
        .eq('type', 'outflow').is('deleted_at', null)
        .order('entry_date', { ascending: false }).limit(100)
      const entries = outflows || []
      let creditedByEntry: Record<string, number> = {}
      if (entries.length > 0) {
        const { data: credits } = await admin
          .from('ad_wallet_ledger').select('cashbook_entry_id, amount')
          .eq('direction', 'credit').is('deleted_at', null)
          .in('cashbook_entry_id', entries.map((e: any) => e.id))
        creditedByEntry = (credits || []).reduce((acc: Record<string, number>, r: any) => {
          acc[r.cashbook_entry_id] = (acc[r.cashbook_entry_id] || 0) + Number(r.amount || 0)
          return acc
        }, {})
      }
      fundCandidates = entries.map((e: any) => ({
        ...e,
        uncredited: Math.round((Number(e.amount || 0) - (creditedByEntry[e.id] || 0)) * 100) / 100,
      }))
    } catch { /* cashbook not readable — Add Funds simply shows no candidates */ }
  }

  // Server-side strip: `select('*')` includes the agency's service-charge
  // terms — confidential billing config that must never reach a non-billing
  // viewer's browser (masking at render time would still ship it in the RSC
  // payload).
  const safeProjects = viewBilling ? projects : projects.map(p => ({
    ...p, service_charge_type: null, service_charge_value: null, tax_percent: null,
  }))

  return {
    migrated, projects: safeProjects, clients, ledger, walletSupported,
    metricsByProject, benchmarksByProject, attention, fundCandidates, pendingRequests,
  }
}

// ─── Needs-attention inputs ─────────────────────────────────────────────────

type One<T> = T | T[] | null
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v)
type Rows<T> = { data: T[] | null; error?: unknown }
/** A failed read (missing table, network) becomes an empty, flagged result. */
const safe = <T,>(p: PromiseLike<Rows<T>>): Promise<Rows<T>> =>
  Promise.resolve(p).then(r => r, () => ({ data: null, error: { message: 'unavailable' } }))

interface ConnRow { id: string; provider: string; status: string; token_expires_at: string | null; client: One<{ name: string }> }
interface ReportRow { id: string; status: string; error_message: string | null; created_at: string; project: One<{ campaign_name: string }> }
interface EmailRow { report_id: string; recipient_email: string; occurred_at: string }
interface OwnerRow { id: string; cqid: string }
interface SnoozeRow { alert_key: string; snoozed_until: string }

async function loadAttentionInputs(
  admin: ReturnType<typeof createAdminClient>,
  projects: { created_by?: string | null }[],
  migrated: boolean,
  clientId?: string,
): Promise<AttentionData> {
  const empty: AttentionData = { connections: [], failedReports: [], failedEmails: [], ownerCqids: {}, snoozes: {}, snoozeSupported: false }
  if (!migrated) return empty
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const ownerIds = [...new Set(projects.map(p => p.created_by).filter((v): v is string => !!v))]

  let connQ = admin.from('provider_connections').select('id, provider, status, token_expires_at, client:clients(name)')
  if (clientId) connQ = connQ.eq('client_id', clientId)
  let reportQ = admin.from('ad_reports').select('id, status, error_message, created_at, project:ad_projects(campaign_name)')
    .eq('status', 'failed').gte('created_at', weekAgo)
  if (clientId) reportQ = reportQ.eq('client_id', clientId)

  const [conns, reports, emails, owners, snoozes] = await Promise.all([
    safe<ConnRow>(connQ as unknown as PromiseLike<Rows<ConnRow>>),
    safe<ReportRow>(reportQ.order('created_at', { ascending: false }).limit(20) as unknown as PromiseLike<Rows<ReportRow>>),
    safe<EmailRow>(admin.from('ad_report_analytics').select('report_id, recipient_email, occurred_at')
      .eq('event', 'email_failed').gte('occurred_at', weekAgo).limit(20) as unknown as PromiseLike<Rows<EmailRow>>),
    // Owners render as CQIDs only — employee names never leave the server.
    ownerIds.length
      ? safe<OwnerRow>(admin.from('employees').select('id, cqid').in('id', ownerIds) as unknown as PromiseLike<Rows<OwnerRow>>)
      : Promise.resolve({ data: [] as OwnerRow[] }),
    safe<SnoozeRow>(admin.from('ad_attention_snoozes').select('alert_key, snoozed_until')
      .gt('snoozed_until', new Date().toISOString()) as unknown as PromiseLike<Rows<SnoozeRow>>),
  ])

  return {
    connections: (conns.data ?? []).map(c => ({
      id: c.id,
      name: `${c.provider === 'meta' ? 'Meta' : c.provider} — ${one(c.client)?.name ?? 'client'}`,
      status: c.status,
      tokenExpiresAt: c.token_expires_at ?? null,
    })),
    failedReports: (reports.data ?? []).map(r => ({
      id: r.id, status: r.status, createdAt: r.created_at, errorMessage: r.error_message ?? null,
      campaignName: one(r.project)?.campaign_name ?? null,
    })),
    failedEmails: (emails.data ?? []).map(e => ({ reportId: e.report_id, recipient: e.recipient_email, at: e.occurred_at })),
    ownerCqids: Object.fromEntries((owners.data ?? []).map(e => [e.id, e.cqid])),
    snoozes: Object.fromEntries((snoozes.data ?? []).map(r => [r.alert_key, r.snoozed_until])),
    snoozeSupported: !snoozes.error,
  }
}
