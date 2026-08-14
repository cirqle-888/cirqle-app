/**
 * Who owns a discovered marketing asset — and therefore who may see its data.
 *
 * One agency Meta login reaches every client's Pages and ad accounts AND
 * Cirqle's own. Without an explicit owner, discovery has to guess, and a guess
 * puts the agency's own marketing inside a client's report.
 *
 * This module is the ONLY place that decides visibility. It is pure and has no
 * database access, so the rule can be tested exhaustively — including the case
 * that actually matters: that no client ever sees another client's data, or
 * Cirqle's.
 */

export type AssetOwnerType = 'client' | 'cirqle' | 'unassigned'

export const ASSET_OWNER_TYPES: AssetOwnerType[] = ['client', 'cirqle', 'unassigned']

/** The ownership fields every asset table carries. */
export interface OwnedAsset {
  owner_type?: AssetOwnerType | string | null
  client_id?: string | null
  /** Set when a human assigned this asset. Sync must not overwrite it. */
  assigned_at?: string | null
}

/**
 * Normalise a raw `owner_type`.
 *
 * Defaults to 'client' — matching the column default, so a row written before
 * this feature existed reads exactly as it always did. An unrecognised value
 * is treated as 'unassigned' rather than 'client': an unknown owner must fail
 * CLOSED (into no client's view), never open.
 */
export function ownerTypeOf(asset: OwnedAsset): AssetOwnerType {
  const raw = asset.owner_type
  if (raw == null) return 'client'
  if (raw === 'client' || raw === 'cirqle' || raw === 'unassigned') return raw
  return 'unassigned'
}

/**
 * May this asset appear in the given client's reports, dashboards or billing?
 *
 * The whole isolation guarantee is these four lines. Cirqle-owned and
 * unassigned assets belong to NO client, and a client only ever sees rows
 * carrying its own id.
 */
export function belongsToClient(asset: OwnedAsset, clientId: string): boolean {
  if (!clientId) return false
  if (ownerTypeOf(asset) !== 'client') return false
  return !!asset.client_id && asset.client_id === clientId
}

/** Is this one of Cirqle's own assets? Never visible in client-facing views. */
export function isCirqleOwned(asset: OwnedAsset): boolean {
  return ownerTypeOf(asset) === 'cirqle'
}

/** Discovered but not yet triaged — visible only on the assignment screen. */
export function isUnassigned(asset: OwnedAsset): boolean {
  return ownerTypeOf(asset) === 'unassigned'
}

/**
 * Has a human decided this asset's owner?
 *
 * Sync, refresh and rediscovery may set an owner only while this is false.
 * This is the anti-clobber rule: the machine stops guessing once a person has
 * answered.
 */
export function isManuallyAssigned(asset: OwnedAsset): boolean {
  return !!asset.assigned_at
}

/**
 * The owner discovery should write for an asset it has just seen.
 *
 * `existing` is the row already in the database, if any. A manual assignment
 * always wins; otherwise the connection's client is a reasonable default for
 * something genuinely new.
 */
export function resolveDiscoveredOwner(
  existing: OwnedAsset | null | undefined,
  fallbackClientId: string | null,
): { owner_type: AssetOwnerType; client_id: string | null } {
  if (existing && isManuallyAssigned(existing)) {
    return {
      owner_type: ownerTypeOf(existing),
      client_id: existing.client_id ?? null,
    }
  }
  if (existing) {
    // Seen before but never triaged: leave it exactly as it is rather than
    // re-stamping it with whichever connection happened to run this time.
    return {
      owner_type: ownerTypeOf(existing),
      client_id: existing.client_id ?? null,
    }
  }
  // Brand new. With no client to fall back on it is explicitly unassigned —
  // NOT silently attached to someone.
  return fallbackClientId
    ? { owner_type: 'client', client_id: fallbackClientId }
    : { owner_type: 'unassigned', client_id: null }
}

/** Keep only the assets a given client is entitled to see. */
export function forClient<T extends OwnedAsset>(assets: T[], clientId: string): T[] {
  return assets.filter(a => belongsToClient(a, clientId))
}

/** Keep only Cirqle's own assets. */
export function forCirqle<T extends OwnedAsset>(assets: T[]): T[] {
  return assets.filter(isCirqleOwned)
}

/** Keep only assets awaiting triage. */
export function unassignedOnly<T extends OwnedAsset>(assets: T[]): T[] {
  return assets.filter(isUnassigned)
}

/**
 * Split a mixed list the way the Agency dashboard presents it: client work,
 * Cirqle's own, and what still needs a decision. Deliberately three buckets
 * with no overlap, so a total can never double-count.
 */
export function partitionByOwner<T extends OwnedAsset>(assets: T[]): {
  client: T[]
  cirqle: T[]
  unassigned: T[]
} {
  const out = { client: [] as T[], cirqle: [] as T[], unassigned: [] as T[] }
  for (const a of assets) out[ownerTypeOf(a)].push(a)
  return out
}

/**
 * Is moving an asset between these owners a change that needs confirming?
 *
 * Moving to or from Cirqle-owned reclassifies data as internal or billable, and
 * moving between clients moves reporting and money from one to another. Both
 * deserve a deliberate yes; re-picking the same owner does not.
 */
export function requiresConfirmation(
  from: { ownerType: AssetOwnerType; clientId: string | null },
  to: { ownerType: AssetOwnerType; clientId: string | null },
): boolean {
  if (from.ownerType === to.ownerType && from.clientId === to.clientId) return false
  if (from.ownerType === 'cirqle' || to.ownerType === 'cirqle') return true
  // Client → different client moves history between two billable parties.
  if (from.ownerType === 'client' && to.ownerType === 'client') return true
  // Unassigned → anywhere is the normal triage path; no ceremony needed.
  return false
}
