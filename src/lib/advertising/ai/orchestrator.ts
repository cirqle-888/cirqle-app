import { createAdminClient } from '@/lib/supabase/server'
import { getAIProvider } from './registry'
import { checkCache, saveCache, hashPayload } from './cache'
import { recordTokenUsage } from './usage'
import { checkDailyBudget } from './cost'

export interface AIOrchestrationOptions {
  clientId: string
  projectId?: string
  analysisType: string
  payload: any
  promptType: string
}

export async function orchestrateAI(options: AIOrchestrationOptions) {
  const supabase = createAdminClient()
  
  // 1. Load Company Settings
  const { data: settings } = await supabase
    .from('company_settings')
    .select('*')
    .eq('client_id', options.clientId)
    .single()
    
  if (!settings || !settings.ai_enabled) {
    throw new Error('AI is disabled for this company or settings missing.')
  }

  // 2. Budget / Cost Check
  const budgetSafe = await checkDailyBudget(options.clientId, settings.daily_ai_budget || 10)
  if (!budgetSafe) {
    // If budget exceeded, return a graceful fallback / skip LLM
    throw new Error('Daily AI Budget Exceeded. Falling back to statistical engine.')
  }

  // 3. Load Active Prompt
  const { data: promptEntry } = await supabase
    .from('ai_prompts')
    .select('*')
    .eq('prompt_type', options.promptType)
    .eq('status', 'active')
    .single()
    
  if (!promptEntry) {
    throw new Error(`No active prompt found for type: ${options.promptType}`)
  }

  const providerId = settings.default_ai_provider || promptEntry.provider || 'groq'
  const model = settings.default_model || promptEntry.model || 'llama-3.3-70b-versatile'
  
  const payloadHash = hashPayload(options.payload)
  const promptHash = hashPayload(promptEntry.prompt_template) // simplified hash of the prompt text

  // 4. Check Cache
  const cached = await checkCache(
    options.clientId,
    options.analysisType,
    payloadHash,
    promptHash,
    model,
    options.projectId
  )

  if (cached) {
    return cached.response
  }

  // 5. Call Provider via Registry
  const provider = getAIProvider(providerId)
  
  const aiOptions = {
    model,
    temperature: settings.ai_temperature || promptEntry.temperature || 0.7,
    max_tokens: settings.ai_max_tokens || promptEntry.max_tokens || 2000,
  }

  const aiResult = await provider.generate(promptEntry.prompt_template, options.payload, aiOptions)

  // 6. Validate JSON Response Format (Basic Check)
  if (!aiResult.response || typeof aiResult.response !== 'object') {
    throw new Error('AI Provider returned invalid structure.')
  }

  // 7. Save Cache
  await saveCache({
    client_id: options.clientId,
    project_id: options.projectId,
    analysis_type: options.analysisType,
    payload_hash: payloadHash,
    prompt_hash: promptHash,
    provider: providerId,
    model: model,
    prompt_version: promptEntry.version,
    response: aiResult.response,
    latency_ms: aiResult.latency_ms,
    prompt_tokens: aiResult.prompt_tokens,
    completion_tokens: aiResult.completion_tokens,
    total_tokens: aiResult.total_tokens,
    estimated_cost: aiResult.estimated_cost
  }, settings.ai_cache_ttl || 24)

  // 8. Track Cost & Usage
  await recordTokenUsage({
    clientId: options.clientId,
    projectId: options.projectId,
    provider: providerId,
    model: model,
    promptTokens: aiResult.prompt_tokens,
    completionTokens: aiResult.completion_tokens,
    totalTokens: aiResult.total_tokens,
    estimatedCost: aiResult.estimated_cost,
    latencyMs: aiResult.latency_ms
  })

  return aiResult.response
}
