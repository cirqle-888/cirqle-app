/**
 * Offer adapter — a pasted product list. Reuses aiParseOfferProducts (the same
 * parser the Offer Intake bulk-paste uses). Commit goes through saveCampaign.
 */
import { aiParseOfferProducts, type ParsedOfferProduct } from '@/lib/ai/offer-capture'
import type { AdapterContext, CaptureDraft, CaptureInput, DetectedClient, ModuleAdapter } from '../types'

export function buildOfferDraft(products: ParsedOfferProduct[], client: DetectedClient | null): CaptureDraft {
  const n = products.length
  return {
    type: 'offer',
    target: '/dashboard/apps/offer-intake',
    summary: `${n} product${n === 1 ? '' : 's'}${client ? ` · ${client.name}` : ''}`,
    client,
    fields: {
      products,
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
    },
  }
}

export const offerAdapter: ModuleAdapter = {
  type: 'offer',
  async prepare(input: CaptureInput, _classification, ctx: AdapterContext): Promise<CaptureDraft> {
    const { products } = await aiParseOfferProducts(input.payload)
    return buildOfferDraft(products, ctx.client)
  },
}
