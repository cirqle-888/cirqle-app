/**
 * The page a campaign advertises (ad_projects.page_account_id → social_accounts).
 *
 * A company campaign is only "no client", so this is what tells Cirqle's own
 * pages apart (Cirqle Works, Cirqle Flyers). Client campaigns may name one of
 * the client's pages too.
 *
 * Every read is best-effort: before migration 20261121200000 the column does
 * not exist, and nothing here may break the advertising pages because of it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CampaignPageOption {
  id: string
  name: string
  username: string | null
  platform: 'facebook_page' | 'instagram' | string
  clientId: string | null
  ownerType: string | null
}

/** "Cirqle Flyers · Facebook" / "@cirqle_flyers · Instagram". */
export function pageLabel(p: Pick<CampaignPageOption, 'name' | 'username' | 'platform'>): string {
  if (p.platform === 'instagram') return `${p.username ? `@${p.username}` : p.name} · Instagram`
  return `${p.name} · Facebook`
}

/**
 * The pages a campaign may name: Cirqle's own for a company campaign, the
 * client's own for a client campaign. Never another client's page.
 */
export function pagesFor(options: CampaignPageOption[], clientId: string | null): CampaignPageOption[] {
  return options.filter(o => clientId
    ? o.ownerType !== 'cirqle' && o.ownerType !== 'unassigned' && o.clientId === clientId
    : o.ownerType === 'cirqle')
}

/** Every connected page/account, for the pickers. Empty if unreadable. */
export async function loadPageOptions(admin: SupabaseClient): Promise<CampaignPageOption[]> {
  try {
    const { data, error } = await admin
      .from('social_accounts')
      .select('id, name, username, platform, client_id, owner_type')
      .order('name')
    if (error) return []
    return (data ?? []).map((r: any) => ({
      id: r.id, name: r.name, username: r.username ?? null, platform: r.platform,
      clientId: r.client_id ?? null, ownerType: r.owner_type ?? null,
    }))
  } catch { return [] }
}

/**
 * Attach `page` ({ id, name, username, platform }) to each project that names
 * one. A separate read rather than an embedded join, so a database without
 * the column still loads the campaigns.
 */
export async function attachPages<T extends { page_account_id?: string | null }>(
  admin: SupabaseClient,
  projects: T[],
): Promise<(T & { page?: Pick<CampaignPageOption, 'id' | 'name' | 'username' | 'platform'> | null })[]> {
  const ids = [...new Set(projects.map(p => p.page_account_id).filter((v): v is string => !!v))]
  if (!ids.length) return projects
  try {
    const { data } = await admin.from('social_accounts').select('id, name, username, platform').in('id', ids)
    const byId = new Map((data ?? []).map((r: any) => [r.id as string, r]))
    return projects.map(p => ({ ...p, page: p.page_account_id ? byId.get(p.page_account_id) ?? null : null }))
  } catch { return projects }
}
