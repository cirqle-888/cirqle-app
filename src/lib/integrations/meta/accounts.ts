/**
 * Meta social asset discovery — Facebook Pages + linked Instagram professional
 * accounts. Runs after OAuth (and on manual "Refresh accounts") and normalizes
 * everything into the `social_accounts` table (spec §22: adapter layer).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { metaGraph, metaGraphAll, redactTokens } from './client'
import { encryptToken } from '@/lib/integrations/tokens'

export interface SocialDiscoveryResult {
  pages: number
  instagramAccounts: number
  errors: string[]
}

interface MetaPage {
  id: string
  name: string
  access_token?: string
  followers_count?: number
  picture?: { data?: { url?: string } }
  category?: string
  instagram_business_account?: {
    id: string
    username?: string
    name?: string
    profile_picture_url?: string
    followers_count?: number
  }
}

/**
 * Fetch the granted permission list for a user token (`/me/permissions`).
 * Returns only permissions with status === 'granted'.
 */
export async function fetchGrantedScopes(userToken: string): Promise<string[]> {
  try {
    const rows = await metaGraphAll<{ permission: string; status: string }>('me/permissions', {
      token: userToken,
    })
    return rows.filter((r) => r.status === 'granted').map((r) => r.permission)
  } catch {
    return []
  }
}

/**
 * Discover all Pages the connected user manages (with their non-expiring Page
 * tokens) plus any linked Instagram professional accounts, and upsert them into
 * social_accounts for the given Cirqle client.
 *
 * Page tokens are stored encrypted. Existing rows are refreshed (name, picture,
 * followers, token) but `publishing_enabled` / `insights_enabled` toggles are
 * never overwritten.
 */
export async function discoverSocialAccounts(
  admin: SupabaseClient,
  connectionId: string,
  clientId: string,
  userToken: string,
): Promise<SocialDiscoveryResult> {
  const result: SocialDiscoveryResult = { pages: 0, instagramAccounts: 0, errors: [] }

  let pages: MetaPage[] = []
  try {
    pages = await metaGraphAll<MetaPage>('me/accounts', {
      token: userToken,
      params: {
        fields:
          'id,name,access_token,category,followers_count,picture{url},' +
          'instagram_business_account{id,username,name,profile_picture_url,followers_count}',
        limit: 50,
      },
    })
  } catch (err: any) {
    result.errors.push(redactTokens(err?.message ?? 'Failed to list Pages'))
    return result
  }

  const now = new Date().toISOString()

  for (const page of pages) {
    try {
      const { data: pageRow, error: pageErr } = await admin
        .from('social_accounts')
        .upsert(
          {
            client_id: clientId,
            connection_id: connectionId,
            provider: 'meta',
            platform: 'facebook_page',
            external_id: page.id,
            name: page.name,
            profile_picture_url: page.picture?.data?.url ?? null,
            followers_count: page.followers_count ?? null,
            access_token: page.access_token ? encryptToken(page.access_token) : null,
            status: 'connected',
            last_error: null,
            metadata: { category: page.category ?? null, discovered_at: now },
          },
          { onConflict: 'platform,external_id' },
        )
        .select('id')
        .single()

      if (pageErr) {
        result.errors.push(`Page ${page.name}: ${pageErr.message}`)
        continue
      }
      result.pages++

      const ig = page.instagram_business_account
      if (ig?.id) {
        const { error: igErr } = await admin.from('social_accounts').upsert(
          {
            client_id: clientId,
            connection_id: connectionId,
            provider: 'meta',
            platform: 'instagram',
            external_id: ig.id,
            name: ig.name || ig.username || `Instagram ${ig.id}`,
            username: ig.username ?? null,
            profile_picture_url: ig.profile_picture_url ?? null,
            followers_count: ig.followers_count ?? null,
            linked_page_account_id: pageRow?.id ?? null,
            status: 'connected',
            last_error: null,
            metadata: { linked_page_external_id: page.id, discovered_at: now },
          },
          { onConflict: 'platform,external_id' },
        )
        if (igErr) result.errors.push(`Instagram @${ig.username ?? ig.id}: ${igErr.message}`)
        else result.instagramAccounts++
      }
    } catch (err: any) {
      result.errors.push(redactTokens(err?.message ?? `Failed on page ${page.id}`))
    }
  }

  return result
}

/**
 * Subscribe the app to a Page's webhook fields (leadgen + feed). Requires the
 * Page token and pages_manage_metadata. Safe to call repeatedly (idempotent on
 * Meta's side). Returns false (never throws) when subscription fails.
 */
export async function subscribePageWebhooks(pageId: string, pageToken: string): Promise<boolean> {
  try {
    const res = await metaGraph<{ success?: boolean }>(`${pageId}/subscribed_apps`, {
      method: 'POST',
      token: pageToken,
      body: { subscribed_fields: 'leadgen,feed' },
    })
    return res?.success === true
  } catch (err: any) {
    console.warn(`[subscribePageWebhooks] page ${pageId}:`, redactTokens(err?.message))
    return false
  }
}
