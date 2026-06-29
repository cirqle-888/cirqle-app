import { AIProvider, AIOptions, AIResponse } from '../interface'

export class GroqProvider implements AIProvider {
  public readonly id = 'groq'

  async generate(prompt: string, payload: any, options: AIOptions = {}): Promise<AIResponse> {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) throw new Error('GROQ_API_KEY environment variable is missing')

    const model = options.model || 'llama-3.3-70b-versatile'
    const startTime = Date.now()
    
    // Convert the payload to a JSON string instruction
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

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Groq API Error: ${response.status} - ${errText}`)
    }

    const data = await response.json()
    const latency_ms = Date.now() - startTime
    
    const content = data.choices[0]?.message?.content
    let parsed: any = null
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      throw new Error('Groq returned invalid JSON')
    }

    const prompt_tokens = data.usage?.prompt_tokens || 0
    const completion_tokens = data.usage?.completion_tokens || 0
    const total_tokens = data.usage?.total_tokens || 0

    // Approximate Groq cost (e.g. Llama 3 70B is around $0.59 / 1M input, $0.79 / 1M output)
    const inputCostPerM = 0.59
    const outputCostPerM = 0.79
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
