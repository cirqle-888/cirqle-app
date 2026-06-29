import { AdProvider } from './interface'
import { metaProvider } from './meta'

const providers: Record<string, AdProvider> = {
  meta: metaProvider,
  // Add new providers here as they are implemented (e.g., google: googleProvider)
}

export function getProvider(name: string): AdProvider {
  const provider = providers[name.toLowerCase()]
  if (!provider) {
    throw new Error(`Advertising provider "${name}" is not implemented.`)
  }
  return provider
}
