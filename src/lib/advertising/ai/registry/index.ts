import { AIProvider } from './interface'
import { GroqProvider } from './adapters/groq'
import { OpenaiProvider } from './adapters/openai'
import { GeminiProvider } from './adapters/gemini'
import { AnthropicProvider } from './adapters/anthropic'
import { OllamaProvider } from './adapters/ollama'

const providers: Record<string, AIProvider> = {
  'groq': new GroqProvider(),
  'openai': new OpenaiProvider(),
  'gemini': new GeminiProvider(),
  'anthropic': new AnthropicProvider(),
  'ollama': new OllamaProvider(),
}

/**
 * Factory method to retrieve the configured AI provider.
 * Throws an error if the requested provider is not supported.
 */
export function getAIProvider(providerId: string): AIProvider {
  const provider = providers[providerId.toLowerCase()]
  if (!provider) {
    throw new Error(`AI Provider '${providerId}' is not registered.`)
  }
  return provider
}
