import { AIProvider, AIOptions, AIResponse } from '../interface'

export class AnthropicProvider implements AIProvider {
  public readonly id = 'anthropic'

  async generate(prompt: string, payload: any, options: AIOptions = {}): Promise<AIResponse> {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is missing')

    const model = options.model || 'claude-3-5-sonnet-20240620'
    const startTime = Date.now()
    
    const userMessage = `Context: ${JSON.stringify(payload)}\n\nPrompt: ${prompt}\n\nIMPORTANT: Return strictly valid JSON matching the requested schema. No markdown wrapping.`

    const body = {
      model,
      system: 'You are an expert digital marketing analyst. Always reply in strictly valid JSON format matching the requested schema. Do not include any conversational text before or after the JSON.',
      messages: [
        { role: 'user', content: userMessage }
      ],
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 2000,
      top_p: options.top_p ?? 1,
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Anthropic API Error: ${response.status} - ${errText}`)
    }

    const data = await response.json()
    const latency_ms = Date.now() - startTime
    
    const content = data.content?.[0]?.text
    let parsed: any = null
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      throw new Error('Anthropic returned invalid JSON')
    }

    const prompt_tokens = data.usage?.input_tokens || 0
    const completion_tokens = data.usage?.output_tokens || 0
    const total_tokens = prompt_tokens + completion_tokens

    // Approximate Claude 3.5 Sonnet cost: $3.00 / 1M input, $15.00 / 1M output
    const inputCostPerM = 3.00
    const outputCostPerM = 15.00
    const estimated_cost = ((prompt_tokens / 1000000) * inputCostPerM) + ((completion_tokens / 1000000) * outputCostPerM)

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
