/**
 * Every discovered marketing asset, as one list.
 *
 * Pages, Instagram accounts, ad accounts and lead forms live in separate tables
 * with different column names — but the owner has one question about all of
 * them: *whose is this?* This module presents them uniformly so the assignment
 * screen and the ownership rule work on one shape instead of four.
 *
 * Deliberately additive: it reads the existing tables and writes only the
 * ownership columns. Nothing here changes how Social Hub, Advertising or Leads
 * load their own data.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AssetOwnerType } from './ownership'
import { ownerTypeOf } from './ownership'

export type AssetKind = 'facebook_page' | 'instagram' | 'ad_account' | 'lead_form'

export const ASSET_KIND_LABEL: Record<AssetKind, string> = {
  facebook_page: 'Facebook Page',
  instagram: 'Instagram',
  ad_account: 'Ad Account',
  lead_form: 'Lead Form',
}

/** Which table an asset came from — needed to write the assignment back. */
export const ASSET_TABLE: Record<AssetKind, string> = {
  facebook_page: 'social_accounts',
  instagram: 'social_accounts',
  ad_account: 'ad_accounts',
  lead_form: 'lead_forms',
}

export interface AssetRow {
  id: string
  kind: AssetKind
  name: string
  /** Platform-side identifier, shown so an owner can match it to Meta. */
  externalId: string | null
  ownerType: AssetOwnerType
  clientId: string | null
  clientName: string | null
  /** Set once a human has decided — sync no longer touches this asset. */
  assignedAt: string | null
  /** Health-ish context, when the underlying table carries it. */
  status: string | null
  lastSyncedAt: string | null
  followers: number | null
  currency: string | null
}

interface ClientLookup { get(id: string | null | undefined): string | null }

function lookup(clients: { id: string; name: string }[]): ClientLookup {
  const m = new Map(clients.map(c => [c.id, c.name]))
  return { get: id => (id ? m.get(id) ?? null : null) }
}

/**
 * Load every asset across all four tables.
 *
 * Each read is independently guarded: a table that has not been migrated yet
 * (or does not exist in an older environment) contributes nothing rather than
 * failing the whole page. Marketing assets are not worth a 500.
 */
export async function loadAllAssets(
  admin: SupabaseClient,
): Promise<{ assets: AssetRow[]; clients: { id: string; name: string }[] }> {
  const { data: clientRows } = await admin
    .from('clients').select('id, name').order('name')
  const clients = (clientRows ?? []) as { id: string; name: string }[]
  const name = lookup(clients)

  const assets: AssetRow[] = []

  // ── Pages + Instagram ─────────────────────────────────────────────────────
  try {
    const { data } = await admin
      .from('social_accounts')
      .select('id, platform, name, username, external_id, client_id, owner_type, assigned_at, status, last_synced_at, followers_count')
      .order('name')
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      assets.push({
        id: String(r.id),
        kind: (r.platform === 'instagram' ? 'instagram' : 'facebook_page') as AssetKind,
        name: String(r.name ?? r.username ?? 'Unnamed'),
        externalId: (r.external_id as string) ?? null,
        ownerType: ownerTypeOf(r as never),
        clientId: (r.client_id as string) ?? null,
        clientName: name.get(r.client_id as string),
        assignedAt: (r.assigned_at as string) ?? null,
        status: (r.status as string) ?? null,
        lastSyncedAt: (r.last_synced_at as string) ?? null,
        followers: (r.followers_count as number) ?? null,
        currency: null,
      })
    }
  } catch { /* not migrated — contribute nothing */ }

  // ── Ad accounts ───────────────────────────────────────────────────────────
  try {
    const { data } = await admin
      .from('ad_accounts')
      .select('id, name, account_id, client_id, owner_type, assigned_at, is_active, currency')
      .order('name')
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      assets.push({
        id: String(r.id),
        kind: 'ad_account',
        name: String(r.name ?? r.account_id ?? 'Unnamed'),
        externalId: (r.account_id as string) ?? null,
        ownerType: ownerTypeOf(r as never),
        clientId: (r.client_id as string) ?? null,
        clientName: name.get(r.client_id as string),
        assignedAt: (r.assigned_at as string) ?? null,
        status: r.is_active === false ? 'inactive' : 'active',
        lastSyncedAt: null,
        followers: null,
        currency: (r.currency as string) ?? null,
      })
    }
  } catch { /* ignore */ }

  // ── Lead forms ────────────────────────────────────────────────────────────
  try {
    const { data } = await admin
      .from('lead_forms')
      .select('id, name, external_form_id, client_id, owner_type, assigned_at, status, last_synced_at')
      .order('name')
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      assets.push({
        id: String(r.id),
        kind: 'lead_form',
        name: String(r.name ?? r.external_form_id ?? 'Unnamed form'),
        externalId: (r.external_form_id as string) ?? null,
        ownerType: ownerTypeOf(r as never),
        clientId: (r.client_id as string) ?? null,
        clientName: name.get(r.client_id as string),
        assignedAt: (r.assigned_at as string) ?? null,
        status: (r.status as string) ?? null,
        lastSyncedAt: (r.last_synced_at as string) ?? null,
        followers: null,
        currency: null,
      })
    }
  } catch { /* ignore */ }

  return { assets, clients }
}

/** The current owner of one asset, for the confirmation check before a move. */
export async function readAssetOwner(
  admin: SupabaseClient,
  kind: AssetKind,
  id: string,
): Promise<{ ownerType: AssetOwnerType; clientId: string | null; name: string } | null> {
  const table = ASSET_TABLE[kind]
  const { data } = await admin
    .from(table).select('id, name, client_id, owner_type').eq('id', id).maybeSingle()
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    ownerType: ownerTypeOf(row as never),
    clientId: (row.client_id as string) ?? null,
    name: String(row.name ?? 'Asset'),
  }
}
