import { AIProvider, AIOptions, AIResponse } from '../interface'

export class GeminiProvider implements AIProvider {
  public readonly id = 'gemini'

  async generate(prompt: string, payload: any, options: AIOptions = {}): Promise<AIResponse> {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) throw new Error('GEMINI_API_KEY environment variable is missing')

    const model = options.model || 'gemini-2.5-flash'
    const startTime = Date.now()
    
    const userMessage = `Context: ${JSON.stringify(payload)}\n\nPrompt: ${prompt}\n\nIMPORTANT: Return strictly valid JSON matching the requested schema. No markdown wrapping.`

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessage }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.max_tokens ?? 2000,
        topP: options.top_p ?? 1
      }
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(`Gemini API Error: ${response.status} - ${errText}`)
    }

    const data = await response.json()
    const latency_ms = Date.now() - startTime
    
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text
    let parsed: any = null
    try {
      parsed = JSON.parse(content)
    } catch (e) {
      throw new Error('Gemini returned invalid JSON')
    }

    const prompt_tokens = data.usageMetadata?.promptTokenCount || 0
    const completion_tokens = data.usageMetadata?.candidatesTokenCount || 0
    const total_tokens = data.usageMetadata?.totalTokenCount || 0

    // Approximate Gemini cost (e.g. Flash: $0.075 / 1M input, $0.30 / 1M output)
    const inputCostPerM = 0.075
    const outputCostPerM = 0.30
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
