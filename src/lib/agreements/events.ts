/**
 * Client Agreements — Timeline Events
 *
 * Appends timeline events for an agreement. Follows the never-throws pattern
 * of request_activity.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgreementEventAction, EventActorType, Visibility } from './types'

export interface AgreementActivityInput {
  agreementId: string
  actorType: EventActorType
  actorId?: string | null
  actorLabel?: string | null
  action: AgreementEventAction
  visibility?: Visibility
  detail?: any
}

/** Append a timeline entry. Never throws; returns false on failure. */
export async function logAgreementEvent(
  admin: SupabaseClient,
  input: AgreementActivityInput,
): Promise<boolean> {
  try {
    const { error } = await admin.from('client_agreement_events').insert({
      agreement_id: input.agreementId,
      actor_type: input.actorType,
      actor_id: input.actorId ?? null,
      actor_label: input.actorLabel ?? null,
      action: input.action,
      visibility: input.visibility ?? 'internal',
      detail: input.detail ?? null,
    })
    return !error
  } catch {
    return false
  }
}
