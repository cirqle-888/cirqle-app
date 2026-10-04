/**
 * Offer adapter — a pasted offer list.
 *
 * Offer lists are prepared in Offer Studio now (see lib/offers/studio.ts), so
 * Capture no longer parses the products itself — that was a paid AI call whose
 * result had nowhere to go once the in-app Offer Prepare form was retired.
 * The draft just names the client and sends the user to Offer Studio; the
 * capture screen copies the pasted list to the clipboard on the way.
 */
import { OFFER_STUDIO_URL } from '@/lib/offers/studio'
import type { CaptureDraft, DetectedClient, ModuleAdapter } from '../types'

export function buildOfferDraft(client: DetectedClient | null): CaptureDraft {
  return {
    type: 'offer',
    target: OFFER_STUDIO_URL,
    summary: `Offer list${client ? ` · ${client.name}` : ''} — prepare it in Offer Studio`,
    client,
    fields: { clientName: client?.name ?? null },
  }
}

export const offerAdapter: ModuleAdapter = {
  type: 'offer',
  async prepare(_input, _classification, ctx): Promise<CaptureDraft> {
    return buildOfferDraft(ctx.client)
  },
}
