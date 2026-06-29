export interface AIOptions {
  model?: string
  temperature?: number
  max_tokens?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  output_schema?: any
}

export interface AIResponse {
  response: any
  latency_ms: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  estimated_cost: number
}

export interface AIProvider {
  /**
   * The canonical identifier for the provider (e.g. 'openai', 'gemini')
   */
  readonly id: string

  /**
   * Generates a response from the LLM based on a prompt and payload.
   */
  generate(prompt: string, payload: any, options?: AIOptions): Promise<AIResponse>
}
