import { AIProvider, AIOptions, AIResponse } from '../interface'

export class OllamaProvider implements AIProvider {
  public readonly id = 'ollama'

  async generate(prompt: string, payload: any, options: AIOptions = {}): Promise<AIResponse> {
    const baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434'
    const model = options.model || 'llama3'
    const startTime = Date.now()
    
    const userMessage = `Context: ${JSON.stringify(payload)}\n\nPrompt: ${prompt}`

    const body = {
      model,
      messages: [
        { role: 'system', content: 'You are an expert digital marketing analyst. Always reply in strictly valid JSON format matching the requested schema.' },
        { role: 'user', content: userMessage }
      ],
      format: 'json',
      options: {
        temperature: options.temperature ?? 0.7,
        top_p: options.top_p ?? 1
      },
      stream: false
    }

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Ollama API Error: ${response.status} - ${errText}`)
    }

    const data = await response.json()
    const latency_ms = Date.now() - startTime
    
    const content = data.message?.content
    let parsed: any = null
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      throw new Error('Ollama returned invalid JSON')
    }

    const prompt_tokens = data.prompt_eval_count || 0
    const completion_tokens = data.eval_count || 0
    const total_tokens = prompt_tokens + completion_tokens

    // Ollama runs locally, so cost is technically $0.00
    const estimated_cost = 0

    return {
      response: parsed,
      latency_ms,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      estimated_cost
    }
  }
}
