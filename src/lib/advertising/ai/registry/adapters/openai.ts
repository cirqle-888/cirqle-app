import { AIProvider, AIOptions, AIResponse } from '../interface'

export class OpenaiProvider implements AIProvider {
  public readonly id = 'openai'

  async generate(prompt: string, payload: any, options: AIOptions = {}): Promise<AIResponse> {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable is missing')

    const model = options.model || 'gpt-4o'
    const startTime = Date.now()
    
    const userMessage = `Context: ${JSON.stringify(payload)}\n\nPrompt: ${prompt}`

    const body = {
      model,
      messages: [
        { role: 'system', content: 'You are an expert digital marketing analyst. Always reply in strictly valid JSON format matching the requested schema.' },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: options.temperature ?? 0.7,
      max_tokens: options.max_tokens ?? 2000,
      top_p: options.top_p ?? 1,
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`OpenAI API Error: ${response.status} - ${errText}`)
    }

    const data = await response.json()
    const latency_ms = Date.now() - startTime
    
    const content = data.choices[0]?.message?.content
    let parsed: any = null
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      throw new Error('OpenAI returned invalid JSON')
    }

    const prompt_tokens = data.usage?.prompt_tokens || 0
    const completion_tokens = data.usage?.completion_tokens || 0
    const total_tokens = data.usage?.total_tokens || 0

    // Approximate OpenAI cost (e.g. GPT-4o: $5.00 / 1M input, $15.00 / 1M output)
    const inputCostPerM = 5.00
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
