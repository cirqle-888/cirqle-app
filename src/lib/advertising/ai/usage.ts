import { createAdminClient } from '@/lib/supabase/server'

export interface TokenUsageParams {
  clientId: string
  projectId?: string
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCost: number
  latencyMs: number
}

export async function recordTokenUsage(params: TokenUsageParams): Promise<void> {
  const supabase = createAdminClient()
  
  const { error } = await supabase
    .from('ad_ai_usage')
    .insert({
      client_id: params.clientId,
      project_id: params.projectId,
      provider: params.provider,
      model: params.model,
      prompt_tokens: params.promptTokens,
      completion_tokens: params.completionTokens,
      total_tokens: params.totalTokens,
      estimated_cost: params.estimatedCost,
      latency_ms: params.latencyMs
    })

  if (error) {
    console.error('[AI Telemetry] Failed to record usage:', error)
  }
}
