/**
 * Quotation adapter — an RFQ / request for an estimate. Identifies the client
 * and prefills a quotation. Commit goes through the Quotations module.
 */
import type { AdapterContext, CaptureDraft, CaptureInput, DetectedClient, ModuleAdapter } from '../types'

export function buildQuotationDraft(text: string, client: DetectedClient | null): CaptureDraft {
  return {
    type: 'quotation',
    target: '/dashboard/quotations',
    summary: client ? `Quotation — ${client.name}` : 'Quotation',
    client,
    fields: {
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      notes: text,
    },
  }
}

export const quotationAdapter: ModuleAdapter = {
  type: 'quotation',
  async prepare(input: CaptureInput, _classification, ctx: AdapterContext): Promise<CaptureDraft> {
    return buildQuotationDraft(input.payload.trim(), ctx.client)
  },
}
