import type { ProductInput } from '../actions'

type LocalProduct = ProductInput & { _key: string; id?: string; page?: number; display_order?: number }

export interface AiSuggestion {
  type: 'title' | 'badge' | 'text' | 'price' | 'cleanup'
  productKey?: string
  originalValue?: string
  suggestedValue: string
  reason: string
}

export async function generateAiSuggestions(context: { products: LocalProduct[] }): Promise<AiSuggestion[]> {
  // FUTURE: Connect to the actual AI inference engine (e.g. Gemini / OpenAI)
  // For now, this is a local heuristics engine that acts as the prompt parser substitute
  const suggestions: AiSuggestion[] = []

  context.products.forEach(p => {
    // 1. Pricing Intelligence
    if (p.price) {
      const pStr = p.price.toString()
      // Suggest rounding e.g. 61 -> 59, 103 -> 99
      if (pStr.endsWith('1') || pStr.endsWith('2') || pStr.endsWith('3')) {
        const target = Math.floor(p.price / 10) * 10 - 1
        if (target > 0) {
          suggestions.push({
            type: 'price',
            productKey: p._key,
            originalValue: pStr,
            suggestedValue: target.toString(),
            reason: `Rounded price looks more appealing (${target})`
          })
        }
      }
    }

    // 2. Data Cleanup
    if (!p.price) {
      suggestions.push({
        type: 'cleanup',
        productKey: p._key,
        originalValue: '',
        suggestedValue: '',
        reason: `Missing price for ${p.name || 'Unnamed'}`
      })
    }

    // 3. Grammar / Text (mock)
    if (p.offer_text && p.offer_text !== p.offer_text.trim()) {
      suggestions.push({
        type: 'text',
        productKey: p._key,
        originalValue: p.offer_text,
        suggestedValue: p.offer_text.trim(),
        reason: 'Extra spaces detected in offer text'
      })
    }
  })

  return new Promise(resolve => setTimeout(() => resolve(suggestions), 800))
}
