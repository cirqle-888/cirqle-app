import { DequeuedJob, enqueueJob } from '@/lib/jobs/engine'
import { createAdminClient } from '@/lib/supabase/server'
import { publishAdEvent } from '@/lib/advertising/events'

// E1.5 Refinement: The DAG workflow
export async function triggerAIAnalysisDAG(projectId: string) {
  // Enqueue the DAG chain
  const j1 = await enqueueJob({ job_type: 'advertising_metrics_collection', payload: { project_id: projectId }, priority: 'high' })
  const j2 = await enqueueJob({ job_type: 'advertising_benchmark_calc', payload: { project_id: projectId }, priority: 'high', depends_on_job_id: j1 })
  const j3 = await enqueueJob({ job_type: 'advertising_forecast_generation', payload: { project_id: projectId }, priority: 'high', depends_on_job_id: j2 })
  const j4 = await enqueueJob({ job_type: 'advertising_health_score', payload: { project_id: projectId }, priority: 'high', depends_on_job_id: j3 })
  const j5 = await enqueueJob({ job_type: 'advertising_recommendation', payload: { project_id: projectId }, priority: 'high', depends_on_job_id: j4 })
  const j6 = await enqueueJob({ job_type: 'advertising_executive_summary', payload: { project_id: projectId }, priority: 'high', depends_on_job_id: j5 })
  return j6
}

export async function metricsCollectionWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  // Collect metrics logic...
  return { collected: true, project_id }
}

export async function benchmarkCalcWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  // Calculate benchmarks logic...
  return { benchmarked: true, project_id }
}

export async function forecastGenerationWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  // Forecast generation logic...
  return { forecasted: true, project_id }
}

export async function healthScoreWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  // Health score logic...
  return { scored: true, project_id }
}

import { orchestrateAI } from '../ai/orchestrator'

export async function recommendationWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  const supabase = createAdminClient()
  
  // Fetch project to get client_id
  const { data: project } = await supabase.from('ad_projects').select('client_id').eq('id', project_id).single()
  if (!project) throw new Error('Project not found')

  // Generate recommendations via Orchestrator
  const recommendations = await orchestrateAI({
    clientId: project.client_id,
    projectId: project_id,
    analysisType: 'recommendations',
    promptType: 'campaign_recommendations',
    payload: { project_id } // In a real scenario, this would include the metrics, benchmarks, forecast, health score
  })

  // Save insights
  if (Array.isArray(recommendations?.recommendations)) {
    for (const rec of recommendations.recommendations) {
      await supabase.from('ad_ai_insights').insert({
        project_id,
        insight_type: 'recommendation',
        title: rec.title || 'AI Recommendation',
        summary: rec.summary || '',
        root_cause: rec.root_cause || '',
        suggested_action: rec.suggested_action || '',
        business_impact: rec.business_impact || '',
        expected_roi: rec.expected_roi || '',
        estimated_savings: rec.estimated_savings || 0,
        timeline: rec.timeline || 'immediate',
        confidence_score: rec.confidence || 0,
        priority: rec.priority || 'medium',
        supporting_metrics: rec.supporting_metrics || {}
      })
    }
  }

  return { recommended: true, project_id }
}

export async function executiveSummaryWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  const supabase = createAdminClient()
  
  const { data: project } = await supabase.from('ad_projects').select('client_id').eq('id', project_id).single()
  if (!project) throw new Error('Project not found')

  // Generate Exec Summary via Orchestrator
  const execSummary = await orchestrateAI({
    clientId: project.client_id,
    projectId: project_id,
    analysisType: 'executive_summary',
    promptType: 'campaign_exec_summary',
    payload: { project_id }
  })

  await publishAdEvent('ai_analysis_completed' as any, { metadata: { job_id: job.id, project_id, summary: execSummary } })
  return { summarized: true, project_id }
}
