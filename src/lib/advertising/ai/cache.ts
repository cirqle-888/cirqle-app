import { createAdminClient } from '@/lib/supabase/server'
import crypto from 'crypto'

export interface AICacheEntry {
  id: string
  client_id: string
  project_id?: string
  analysis_type: string
  payload_hash: string
  prompt_hash: string
  provider: string
  model: string
  prompt_version: string
  response: any
  latency_ms?: number
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  estimated_cost?: number
  cache_hit_count?: number
  created_by_worker?: string
  expires_at: string
}

/**
 * Deep stable sort of objects to ensure identical hashing regardless of key order.
 */
function stableSerialize(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj)
  }

  if (Array.isArray(obj)) {
    return `[${obj.map(item => stableSerialize(item)).join(',')}]`
  }

  const sortedKeys = Object.keys(obj).sort()
  const keyVals = sortedKeys.map(key => {
    return `"${key}":${stableSerialize(obj[key])}`
  })
  
  return `{${keyVals.join(',')}}`
}

/**
 * Generates a SHA-256 hash of the payload to detect identical requests.
 */
export function hashPayload(payload: any): string {
  const normalized = stableSerialize(payload)
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

/**
 * Checks if a valid, unexpired cache entry exists for the given parameters.
 */
export async function checkCache(
  clientId: string,
  analysisType: string,
  payloadHash: string,
  promptHash: string,
  model: string,
  projectId?: string
): Promise<AICacheEntry | null> {
  const supabase = createAdminClient()
  
  let query = supabase
    .from('ad_ai_cache')
    .select('*')
    .eq('client_id', clientId)
    .eq('analysis_type', analysisType)
    .eq('payload_hash', payloadHash)
    .eq('prompt_hash', promptHash)
    .eq('model', model)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)

  if (projectId) {
    query = query.eq('project_id', projectId)
  }

  const { data, error } = await query.single()
  
  if (error || !data) return null
  
  // Increment cache hit count in background
  supabase.rpc('increment_ai_cache_hit', { row_id: data.id }).then(({ error }) => {
    if (error) console.error('[AI Cache] Failed to increment hit count:', error)
  })

  return data as AICacheEntry
}

/**
 * Saves a new AI response to the cache.
 */
export async function saveCache(
  entry: Omit<AICacheEntry, 'id' | 'expires_at' | 'cache_hit_count'>,
  ttlHours: number = 24
): Promise<void> {
  const supabase = createAdminClient()
  
  const expiresAt = new Date()
  expiresAt.setHours(expiresAt.getHours() + ttlHours)

  const { error } = await supabase
    .from('ad_ai_cache')
    .insert({
      ...entry,
      expires_at: expiresAt.toISOString(),
      cache_hit_count: 0
    })

  if (error) {
    console.error('[AI Cache] Failed to save cache entry:', error)
  }
}

/**
 * Invalidate cache for a specific project. Called when campaign metrics change.
 */
export async function invalidateCache(projectId: string): Promise<void> {
  const supabase = createAdminClient()
  await supabase
    .from('ad_ai_cache')
    .update({ expires_at: new Date().toISOString() }) // expire immediately
    .eq('project_id', projectId)
}
