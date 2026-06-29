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
 * Implements a strict fallback chain to always return meaningful comparison data:
 * Campaign -> Client -> Agency -> Industry -> Global (Agency Avg as fallback)
 */

export async function getBenchmarks(
  projectId: string,
  clientId: string,
  industry: string = 'general'
): Promise<BenchmarkMetrics> {
  const supabase = createAdminClient()

  // 1. Try Campaign Historical (mv_campaign_performance)
  const { data: campaignData } = await supabase
    .from('mv_campaign_performance')
    .select('*')
    .eq('project_id', projectId)
    .single()

  if (campaignData && campaignData.roas > 0) {
    return parseMV(campaignData)
  }

  // 2. Try Client Average (mv_client_performance)
  const { data: clientData } = await supabase
    .from('mv_client_performance')
    .select('*')
    .eq('client_id', clientId)
    .single()

  if (clientData && clientData.roas > 0) {
    return parseMV({ ...clientData, cpc: 0, ctr: 0, cpm: 0, conversion_rate: 0 }) // Client MV has fewer metrics
  }

  // 3. Try Agency Average (mv_agency_benchmarks)
  const { data: agencyData } = await supabase
    .from('mv_agency_benchmarks')
    .select('*')
    .single()

  if (agencyData && agencyData.avg_roas > 0) {
    return {
      roas: agencyData.avg_roas || 0,
      cpc: agencyData.avg_cpc || 0,
      ctr: agencyData.avg_ctr || 0,
      cpa: agencyData.avg_cpa || 0,
      cpm: agencyData.avg_cpm || 0,
      conversion_rate: agencyData.avg_conversion_rate || 0,
      margin: agencyData.avg_margin || 0
    }
  }

  // 4. Fallback to generic defaults (Global) if no data exists at all
  return {
    roas: 1.5,
    cpc: 0.5,
    ctr: 1.2,
    cpa: 25.0,
    cpm: 15.0,
    conversion_rate: 2.0,
    margin: 0.2
  }
}

function parseMV(data: any): BenchmarkMetrics {
  return {
    roas: data.roas || 0,
    cpc: data.cpc || 0,
    ctr: data.ctr || 0,
    cpa: data.cpa || 0,
    cpm: data.cpm || 0,
    conversion_rate: data.conversion_rate || 0,
    margin: data.margin || 0
  }
}
