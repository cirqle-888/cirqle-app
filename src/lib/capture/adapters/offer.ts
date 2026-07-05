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
    // Land on the INTERNAL offer-preparation form (client preselected when
    // matched, picker otherwise) — not the settings page, which listed intake
    // links but couldn't consume the parsed draft.
    target: client ? `/dashboard/offer-prepare/${client.id}` : '/dashboard/offer-prepare',
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
