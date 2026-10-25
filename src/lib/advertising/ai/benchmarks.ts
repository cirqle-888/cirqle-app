import { createAdminClient } from '@/lib/supabase/server'

export interface BenchmarkMetrics {
  roas: number
  cpc: number
  ctr: number
  cpa: number
  cpm: number
  conversion_rate: number
  margin: number
}

/**
 * Benchmark Engine
 *
 * Fallback chain: Campaign -> Client -> Agency -> Global placeholder.
 *
 * The result says WHERE it came from. The last step is a set of hard-coded
 * placeholder numbers (not from any real account), and the report used to
 * label every benchmark "Agency" regardless — so a campaign could be graded
 * "below benchmark" against values nobody measured. Callers must not grade
 * or compare against `source: 'global'`.
 */

export type BenchmarkSource = 'campaign' | 'client' | 'agency' | 'global'

export async function getBenchmarks(
  projectId: string,
  clientId: string,
  industry: string = 'general'
): Promise<BenchmarkMetrics> {
  return (await getBenchmarksWithSource(projectId, clientId, industry)).metrics
}

export interface BenchmarkResult {
  metrics: BenchmarkMetrics
  source: BenchmarkSource
}

export async function getBenchmarksWithSource(
  projectId: string,
  clientId: string,
  // Reserved for an industry tier; no industry data source exists yet.
  _industry: string = 'general'
): Promise<BenchmarkResult> {
  const supabase = createAdminClient()
  const [campaign, client, agency] = await Promise.all([
    supabase.from('mv_campaign_performance').select('*').eq('project_id', projectId).maybeSingle(),
    supabase.from('mv_client_performance').select('*').eq('client_id', clientId).maybeSingle(),
    supabase.from('mv_agency_benchmarks').select('*').maybeSingle(),
  ])
  return chooseBenchmark(campaign.data, client.data, agency.data)
}

/**
 * The same chain for many campaigns at once (the advertising list): one
 * query per tier instead of three per campaign. Keyed by project id.
 */
export async function getBenchmarksForProjects(
  projects: { id: string; client_id: string | null }[],
): Promise<Record<string, BenchmarkResult>> {
  if (projects.length === 0) return {}
  const supabase = createAdminClient()
  const projectIds = projects.map(p => p.id)
  const clientIds = [...new Set(projects.map(p => p.client_id).filter((c): c is string => !!c))]
  const [campaigns, clients, agency] = await Promise.all([
    supabase.from('mv_campaign_performance').select('*').in('project_id', projectIds),
    clientIds.length
      ? supabase.from('mv_client_performance').select('*').in('client_id', clientIds)
      : Promise.resolve({ data: [] as unknown[] }),
    supabase.from('mv_agency_benchmarks').select('*').maybeSingle(),
  ])
  const rows = (r: { data: unknown }) => (Array.isArray(r.data) ? r.data : []) as Record<string, unknown>[]
  const byProject = new Map(rows(campaigns).map(r => [r.project_id as string, r]))
  const byClient = new Map(rows(clients).map(r => [r.client_id as string, r]))
  const out: Record<string, BenchmarkResult> = {}
  for (const p of projects) {
    out[p.id] = chooseBenchmark(byProject.get(p.id), p.client_id ? byClient.get(p.client_id) : null, agency.data)
  }
  return out
}

/**
 * Fallback chain: Campaign → Client → Agency → Global placeholder. A tier is
 * used only when it has a positive ROAS (the materialized views' marker of
 * real data). Pure — shared by the single and batch lookups.
 */
/** A materialized-view row: numeric columns, read defensively. */
type MvRow = Record<string, unknown> | null | undefined

export function chooseBenchmark(campaignRow: MvRow, clientRow: MvRow, agencyRow: MvRow): BenchmarkResult {
  const n = (row: MvRow, key: string) => Number(row?.[key] ?? 0) || 0
  if (n(campaignRow, 'roas') > 0) {
    return { metrics: parseMV(campaignRow), source: 'campaign' }
  }
  if (n(clientRow, 'roas') > 0) {
    // Client MV has fewer metrics
    return { metrics: parseMV({ ...clientRow, cpc: 0, ctr: 0, cpm: 0, conversion_rate: 0 }), source: 'client' }
  }
  if (n(agencyRow, 'avg_roas') > 0) {
    return { source: 'agency', metrics: {
      roas: n(agencyRow, 'avg_roas'),
      cpc: n(agencyRow, 'avg_cpc'),
      ctr: n(agencyRow, 'avg_ctr'),
      cpa: n(agencyRow, 'avg_cpa'),
      cpm: n(agencyRow, 'avg_cpm'),
      conversion_rate: n(agencyRow, 'avg_conversion_rate'),
      margin: n(agencyRow, 'avg_margin')
    } }
  }
  // Placeholder defaults — display-only, never a basis for grading
  return { source: 'global', metrics: {
    roas: 1.5,
    cpc: 0.5,
    ctr: 1.2,
    cpa: 25.0,
    cpm: 15.0,
    conversion_rate: 2.0,
    margin: 0.2
  } }
}

function parseMV(data: MvRow): BenchmarkMetrics {
  const n = (key: string) => Number(data?.[key] ?? 0) || 0
  return {
    roas: n('roas'),
    cpc: n('cpc'),
    ctr: n('ctr'),
    cpa: n('cpa'),
    cpm: n('cpm'),
    conversion_rate: n('conversion_rate'),
    margin: n('margin'),
  }
}
