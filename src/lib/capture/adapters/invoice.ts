/**
 * Invoice adapter — invoices auto-draft from completed work, so capture does
 * NOT blind-create one. It identifies the client and routes to their invoices
 * to match / prefill / attach during commit.
 */
import type { AdapterContext, CaptureDraft, CaptureInput, DetectedClient, ModuleAdapter } from '../types'

export function buildInvoiceDraft(text: string, client: DetectedClient | null): CaptureDraft {
  return {
    type: 'invoice',
    target: '/dashboard/invoices',
    summary: client ? `Invoice — ${client.name}` : 'Invoice',
    client,
    fields: {
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      raw: text,
    },
  }
}

export const invoiceAdapter: ModuleAdapter = {
  type: 'invoice',
  async prepare(input: CaptureInput, _classification, ctx: AdapterContext): Promise<CaptureDraft> {
    return buildInvoiceDraft(input.payload.trim(), ctx.client)
  },
}
