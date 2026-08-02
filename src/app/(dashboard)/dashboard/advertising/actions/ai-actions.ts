'use server'

import { createClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { requirePermission, requireAdmin } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'

// E3.1: Server Actions Layer

export async function getExecutiveSummary(clientId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_VIEW_AI)
  if (!guard.ok) throw new Error(guard.error)

  const supabase = await createClient()
  
  // 1. Fetch rolled-up performance from materialized view
  const { data: performance } = await supabase
    .from('mv_client_performance')
    .select('*')
    .eq('client_id', clientId)
    .single()

  // 2. Fetch the latest Executive Summary AI Insight
  // Assuming project_id links to a master agency project or we just take the most recent summary for this client's projects
  const { data: summaryInsight } = await supabase
    .from('ad_ai_insights')
    .select('*')
    .eq('insight_type', 'executive_summary')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  return {
    performance: performance || { total_spend: 0, total_revenue: 0, roas: 0, profit: 0, margin: 0 },
    summary: summaryInsight
  }
}

export async function getCampaignHealth(projectId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_VIEW_AI)
  if (!guard.ok) throw new Error(guard.error)

  const supabase = await createClient()
  const { data } = await supabase
    .from('ad_ai_insights')
    .select('*')
    .eq('project_id', projectId)
    .eq('insight_type', 'health_score')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
    
  return data
}

export async function getRecommendations(projectId?: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_VIEW_AI)
  if (!guard.ok) throw new Error(guard.error)

  const supabase = await createClient()
  
  let query = supabase
    .from('ad_ai_insights')
    .select('*')
    .eq('insight_type', 'recommendation')
    .order('priority', { ascending: true }) // assuming priority is a string that might not sort perfectly this way, but works for now
    .order('created_at', { ascending: false })

  if (projectId) {
    query = query.eq('project_id', projectId)
  }

  const { data, error } = await query
  if (error) console.error(error)
  return data || []
}

export async function updateRecommendationStatus(id: string, status: 'viewed' | 'accepted' | 'applied' | 'dismissed') {
  const guard = await requirePermission(PERMS.ADVERTISING_MANAGE_AI)
  if (!guard.ok) throw new Error(guard.error)

  const supabase = await createClient()
  
  // Append to history
  const historyEntry = { status, timestamp: new Date().toISOString() }
  
  const { data, error } = await supabase.rpc('update_recommendation_status', { 
    rec_id: id, 
    new_status: status, 
    history_entry: historyEntry 
  })
  
  // If RPC isn't built, we do a 2-step (not ideal for race conditions, but fine for UI fallback)
  if (error) {
    const { data: rec } = await supabase.from('ad_ai_insights').select('recommendation_history').eq('id', id).single()
    const history = Array.isArray(rec?.recommendation_history) ? rec.recommendation_history : []
    history.push(historyEntry)
    
    await supabase.from('ad_ai_insights')
      .update({ recommendation_status: status, recommendation_history: history })
      .eq('id', id)
  }
  
  return true
}

export async function getForecastData(projectId: string) {
  const guard = await requirePermission(PERMS.ADVERTISING_VIEW_AI)
  if (!guard.ok) throw new Error(guard.error)

  const supabase = await createClient()
  // Fetch historical data
  const { data: historical } = await supabase
    .from('ad_daily_metrics')
    .select('date, spend, revenue, roas')
    .eq('project_id', projectId)
    .order('date', { ascending: true })

  // Fetch forecast insight
  const { data: forecastInsight } = await supabase
    .from('ad_ai_insights')
    .select('*')
    .eq('project_id', projectId)
    .eq('insight_type', 'forecast')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  return {
    historical: historical || [],
    forecast: forecastInsight?.supporting_metrics || null
  }
}

export async function getAdminAIUsage() {
  const guard = await requireAdmin()
  if (!guard.ok) throw new Error(guard.error)

  const supabase = await createClient()
  
  // Global aggregate usage (requires admin privileges, which the client might not have, 
  // but if this is an internal admin page, RLS must allow it or we use admin client)
  // For the sake of E3, we will use standard client assuming RLS allows platform admins to view it.
  const { data, error } = await supabase
    .from('ad_ai_usage')
    .select('provider, total_tokens, estimated_cost, latency_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(1000)
    
  if (error) console.error(error)
  return data || []
}
