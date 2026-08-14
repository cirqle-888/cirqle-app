'use server'

/**
 * Asset assignment — the one write path for "whose asset is this?".
 *
 * Assignment moves reporting, leads and billing between parties, so it is
 * permission-gated on its own key (assets.assign), logged, and stamps
 * `assigned_at` — which is what stops sync and rediscovery from ever
 * overwriting the decision.
 *
 * A `'use server'` module may only EXPORT async functions; types stay local or
 * live in @/lib/assets.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { ASSET_TABLE, readAssetOwner, type AssetKind } from '@/lib/assets/registry'
import { requiresConfirmation, type AssetOwnerType } from '@/lib/assets/ownership'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
  /** Set when the move is real but the caller has not confirmed it yet. */
  needsConfirmation?: boolean
  confirmationMessage?: string
}

export interface AssignAssetInput {
  kind: AssetKind
  assetId: string
  ownerType: AssetOwnerType
  /** Required when ownerType is 'client'; ignored otherwise. */
  clientId?: string | null
  /** The caller has seen the confirmation prompt and said yes. */
  confirmed?: boolean
}

/**
 * Point one asset at a client, at Cirqle, or back to unassigned.
 *
 * Refuses rather than guesses: a client assignment with no client, or an
 * unknown client id, is an error — not a silent write that would quietly park
 * data in the wrong place.
 */
export async function assignAsset(input: AssignAssetInput): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ASSETS_ASSIGN)
  if (!guard.ok) return { ok: false, error: guard.error }

  const table = ASSET_TABLE[input.kind]
  if (!table) return { ok: false, error: 'Unknown asset type.' }

  const admin = createAdminClient()
  const current = await readAssetOwner(admin, input.kind, input.assetId)
  if (!current) return { ok: false, error: 'Asset not found.' }

  // ── Validate the target ────────────────────────────────────────────────────
  let clientId: string | null = null
  let clientName: string | null = null
  if (input.ownerType === 'client') {
    if (!input.clientId) return { ok: false, error: 'Pick the client this asset belongs to.' }
    const { data: client } = await admin
      .from('clients').select('id, name').eq('id', input.clientId).maybeSingle()
    if (!client) return { ok: false, error: 'That client no longer exists.' }
    clientId = client.id
    clientName = client.name
  }

  // Re-selecting the same owner is a no-op, not an error — and must not stamp
  // assigned_at, or a stray click would silently freeze an asset against sync.
  if (current.ownerType === input.ownerType && (current.clientId ?? null) === clientId) {
    return { ok: true }
  }

  // ── Confirmation gate ──────────────────────────────────────────────────────
  const needs = requiresConfirmation(
    { ownerType: current.ownerType, clientId: current.clientId },
    { ownerType: input.ownerType, clientId },
  )
  if (needs && !input.confirmed) {
    return {
      ok: false,
      needsConfirmation: true,
      confirmationMessage: describeMove(current, input.ownerType, clientName),
    }
  }

  const { error } = await admin
    .from(table)
    .update({
      owner_type: input.ownerType,
      client_id: clientId,
      assigned_at: new Date().toISOString(),
      assigned_by: guard.employeeId ?? null,
    })
    .eq('id', input.assetId)

  if (error) {
    // The DB CHECK is the last line of defence — surface it in plain language.
    if (/owner_client_ck/.test(error.message)) {
      return { ok: false, error: 'A client-owned asset must have a client.' }
    }
    return { ok: false, error: error.message }
  }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: clientId ?? current.clientId ?? null,
    clientId: clientId ?? undefined,
    category: 'crm',
    action: 'asset_assigned',
    detail: {
      asset: current.name,
      kind: input.kind,
      from: { owner: current.ownerType, client: current.clientId },
      to: { owner: input.ownerType, client: clientId },
    },
  }).catch(() => {})

  // Every surface that reads assets has to reflect the move.
  for (const p of ['/dashboard/assets', '/dashboard/cirqle-accounts', '/dashboard/social',
                   '/dashboard/agency', '/dashboard/leads', '/dashboard/advertising']) {
    revalidatePath(p)
  }
  return { ok: true }
}

/** Plain-language description of what the owner is about to change. */
function describeMove(
  current: { ownerType: AssetOwnerType; clientId: string | null; name: string },
  toOwner: AssetOwnerType,
  toClientName: string | null,
): string {
  const to = toOwner === 'cirqle'
    ? "Cirqle's own accounts"
    : toOwner === 'unassigned'
      ? 'unassigned'
      : (toClientName ?? 'another client')

  if (current.ownerType === 'cirqle') {
    return `${current.name} is currently one of Cirqle's own assets. Moving it to ${to} means its reach, leads and spend start appearing in client reporting and billing.`
  }
  if (toOwner === 'cirqle') {
    return `${current.name} will become one of Cirqle's own assets. It will disappear from client reports, dashboards, leads and billing.`
  }
  return `${current.name} will move to ${to}. Its history moves with it, so both clients' reports will change.`
}
