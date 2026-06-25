/**
 * Client adapter — a contact card / new customer. Extracts name/phone/email
 * from the snippet. If the engine already matched an existing client, the draft
 * surfaces that so the user updates rather than duplicates. Commit goes through
 * quickCreateClient.
 */
import { extractContacts, type ExtractedContacts } from '../client-detect'
import type { AdapterContext, CaptureDraft, CaptureInput, DetectedClient, ModuleAdapter } from '../types'

export function buildClientDraft(contacts: ExtractedContacts, existing: DetectedClient | null): CaptureDraft {
  return {
    type: 'client',
    target: '/dashboard/clients',
    summary: existing
      ? `Existing client: ${existing.name}`
      : (contacts.name || contacts.phone || contacts.email || 'New client'),
    client: existing,
    fields: {
      existingClientId: existing?.id ?? null,
      name: contacts.name ?? '',
      phone: contacts.phone ?? '',
      email: contacts.email ?? '',
    },
  }
}

export const clientAdapter: ModuleAdapter = {
  type: 'client',
  async prepare(input: CaptureInput, _classification, ctx: AdapterContext): Promise<CaptureDraft> {
    const contacts = extractContacts(input.payload, input.metadata)
    return buildClientDraft(contacts, ctx.client)
  },
}
