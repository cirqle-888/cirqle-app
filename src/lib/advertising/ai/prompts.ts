import { createAdminClient } from '@/lib/supabase/server'

export interface AIPrompt {
  id: string
  provider: string
  prompt_type: string
  prompt_version: string
  prompt_status: string
  prompt_template: string
  variables: string[]
  model?: string
  temperature?: number
  max_tokens?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  output_schema?: any
}

/**
 * Loads the currently active prompt for a given provider and type.
 */
export async function getActivePrompt(provider: string, promptType: string): Promise<AIPrompt> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('ai_prompts')
    .select('*')
    .eq('provider', provider)
    .eq('prompt_type', promptType)
    .eq('prompt_status', 'active')
    .single()

  if (error || !data) {
    throw new Error(`No active prompt found for provider '${provider}' and type '${promptType}'. Please configure it in ai_prompts.`)
  }

  return data as AIPrompt
}

/**
 * Compiles a prompt template with the provided variables.
 * E.g. replaces {{budget}} with the value of payload.budget.
 */
export function compilePrompt(template: string, variables: string[], payload: Record<string, any>): string {
  let compiled = template

  for (const variable of variables) {
    const value = payload[variable]
    if (value === undefined) {
      console.warn(`[Prompt Compiler] Missing variable '${variable}' in payload.`)
    }
    const safeValue = value !== undefined ? String(value) : ''
    
    // Replace all occurrences of {{variable}}
    const regex = new RegExp(`{{${variable}}}`, 'g')
    compiled = compiled.replace(regex, safeValue)
  }

  return compiled
}
