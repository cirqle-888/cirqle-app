/**
 * Request adapter — reuses the exact primitives the Requests inbox AI Capture
 * uses (aiParse + findClient/findService in src/lib/ai/request-capture.ts), so
 * the prepared draft matches what aiCaptureRequest produces. No DB writes;
 * commit goes through the Requests module's guarded create action.
 */
import { aiParse, findClient, findService, normalizeDate } from '@/lib/ai/request-capture'
import type { AdapterContext, CaptureDraft, CaptureInput, DetectedClient, ModuleAdapter } from '../types'

export interface ParsedRequest { client?: string; title?: string; service?: string; dueDate?: string }

/** Pure mapping of parsed fields → a review draft (unit-tested). */
export function buildRequestDraft(
  text: string,
  parsed: ParsedRequest,
  client: DetectedClient | null,
  service: { id: string; name: string } | null,
): CaptureDraft {
  const title = (parsed.title || '').trim() || text.slice(0, 80)
  return {
    type: 'request',
    target: '/dashboard/requests',
    summary: title,
    client,
    fields: {
      title,
      description: text,
      clientId: client?.id ?? null,
      clientName: client?.name ?? parsed.client ?? null,
      serviceId: service?.id ?? null,
      serviceName: service?.name ?? parsed.service ?? null,
      dueDate: normalizeDate(parsed.dueDate ?? null),
    },
  }
}

export const requestAdapter: ModuleAdapter = {
  type: 'request',
  async prepare(input: CaptureInput, _classification, ctx: AdapterContext): Promise<CaptureDraft> {
    const text = input.payload.trim()
    const parsed = await aiParse(text)
    let client = ctx.client
    if (!client && parsed.client) {
      const hit = await findClient(ctx.admin, parsed.client)
      if (hit) client = { id: hit.id, name: hit.name, matchedBy: 'name' }
    }
    const svc = await findService(ctx.admin, parsed.service)
    return buildRequestDraft(text, parsed, client, svc ? { id: svc.id, name: svc.name } : null)
  },
}
