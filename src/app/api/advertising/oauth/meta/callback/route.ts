import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { publishAdEvent } from '@/lib/advertising/events'
import { loadCurrentUser } from '@/lib/permissions/check'
import { verifyOAuthState } from '@/lib/oauth/state'
import { GRAPH_URL, META_API_VERSION, metaGraph } from '@/lib/integrations/meta/client'
import { encryptToken } from '@/lib/integrations/tokens'
import { discoverSocialAccounts, fetchGrantedScopes } from '@/lib/integrations/meta/accounts'
import { logActivity } from '@/lib/activity/log'
import { resolveDiscoveredOwner } from '@/lib/assets/ownership'

/**
 * Meta OAuth callback handler.
 * Registered redirect URI: META_REDIRECT_URI env var
 * (https://app.cirqle.work/api/advertising/oauth/meta/callback)
 *
 * Persists: an encrypted long-lived user token on provider_connections, the
 * granted scope list, discovered ad accounts (ad_accounts) and discovered
 * Facebook Pages + Instagram professional accounts (social_accounts, with
 * encrypted non-expiring Page tokens).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const errorReason = url.searchParams.get('error_reason')

  if (error || !code) {
    const msg = errorReason === 'user_denied' ? 'auth_denied' : 'auth_failed'
    return NextResponse.redirect(new URL(`/dashboard/connections?error=${msg}`, req.url))
  }

  const clientId = process.env.META_APP_ID || process.env.META_CLIENT_ID
  const clientSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL('/dashboard/connections?error=not_configured', req.url))
  }

  try {
    // 1. Require a signed-in employee session (the person completing the flow)
    const user = await loadCurrentUser().catch(() => null)
    if (!user) {
      return NextResponse.redirect(new URL('/dashboard/connections?error=not_signed_in', req.url))
    }

    // 2. Verify HMAC-signed state (rejects forged/expired states)
    const state = verifyOAuthState<{ clientId: string; employeeId: string }>(stateParam)
    if (!state) {
      return NextResponse.redirect(new URL('/dashboard/connections?error=invalid_state', req.url))
    }
    const targetClientId = state.clientId
    const employeeId = user.employeeId // attribute to the live session, not the state payload

    if (!targetClientId) throw new Error('Missing target client ID in state')

    // 3. Exchange code for short-lived token
    const redirectUri = process.env.META_REDIRECT_URI || `${url.origin}/api/advertising/oauth/meta/callback`
    const tokenData = await metaGraph<{ access_token: string }>('oauth/access_token', {
      params: {
        client_id: clientId,
        redirect_uri: redirectUri,
        client_secret: clientSecret,
        code,
      },
    })

    // 4. Exchange for long-lived token (~60 days)
    let longLivedData: { access_token?: string; expires_in?: number } = {}
    try {
      longLivedData = await metaGraph('oauth/access_token', {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: clientId,
          client_secret: clientSecret,
          fb_exchange_token: tokenData.access_token,
        },
      })
    } catch (exchangeErr) {
      console.warn('[Meta Callback] long-lived exchange failed, using short-lived token', exchangeErr)
    }

    const accessToken = longLivedData.access_token || tokenData.access_token
    const expiresIn = longLivedData.expires_in || 60 * 60 * 24 * 60 // 60-day default
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // 5. Record what Meta actually granted (config_id flows can grant a subset)
    const grantedScopes = await fetchGrantedScopes(accessToken)

    // 6. Persist connection — token encrypted at rest
    const admin = createAdminClient()
    const { data: conn, error: dbError } = await admin
      .from('provider_connections')
      .upsert(
        {
          client_id: targetClientId,
          provider: 'meta',
          access_token: encryptToken(accessToken),
          token_expires_at: expiresAt,
          status: 'active',
          last_auth_at: new Date().toISOString(),
          connected_by: employeeId,
          granted_scopes: grantedScopes.length ? grantedScopes : null,
          token_type: 'user',
          api_version: META_API_VERSION,
          last_error: null,
        },
        { onConflict: 'client_id,provider' },
      )
      .select('id')
      .single()

    if (dbError) throw dbError

    // 7. Auto-discover ad accounts (non-fatal)
    try {
      const accountsRes = await fetch(
        `${GRAPH_URL}/me/adaccounts` +
          `?fields=account_id,name,currency,timezone_name,business` +
          `&access_token=${accessToken}`,
      )
      const accountsData = await accountsRes.json()

      if (accountsRes.ok && Array.isArray(accountsData.data) && conn) {
        // One agency login reaches every client's ad accounts, so the
        // connection's client is only a default for accounts never seen before.
        // Without this, every reconnect or token refresh resets an account the
        // owner had deliberately pointed at its real client.
        const existingAdAccounts = new Map<string, { owner_type?: string | null; client_id?: string | null; assigned_at?: string | null }>()
        {
          const ids = accountsData.data.map((a: { account_id: string }) => a.account_id)
          if (ids.length) {
            const { data: existing } = await admin
              .from('ad_accounts')
              .select('account_id, client_id, owner_type, assigned_at')
              .eq('provider', 'meta')
              .in('account_id', ids)
            for (const row of existing ?? []) existingAdAccounts.set(row.account_id, row)
          }
        }

        for (const acc of accountsData.data) {
          // Upsert business if present
          let businessRowId: string | null = null
          if (acc.business?.id) {
            const { data: biz } = await admin
              .from('ad_businesses')
              .upsert(
                {
                  connection_id: conn.id,
                  client_id: targetClientId,
                  business_id: acc.business.id,
                  name: acc.business.name || `Business ${acc.business.id}`,
                },
                { onConflict: 'connection_id,business_id' },
              )
              .select('id')
              .single()
            businessRowId = biz?.id ?? null
          }

          await admin.from('ad_accounts').upsert(
            {
              connection_id: conn.id,
              business_id: businessRowId,
              ...resolveDiscoveredOwner(existingAdAccounts.get(acc.account_id) ?? null, targetClientId ?? null),
              provider: 'meta',
              account_id: acc.account_id,
              name: acc.name,
              currency: acc.currency,
              timezone: acc.timezone_name,
              is_active: true,
            },
            { onConflict: 'provider,account_id' },
          )
        }
      }
    } catch (discoveryErr) {
      console.warn('[Meta Callback] Ad account discovery failed:', discoveryErr)
    }

    // 8. Auto-discover Facebook Pages + Instagram accounts (non-fatal).
    //    social_accounts may not exist until its migration is applied — degrade.
    if (conn) {
      try {
        const social = await discoverSocialAccounts(admin, conn.id, targetClientId, accessToken)
        if (social.errors.length) {
          console.warn('[Meta Callback] social discovery partial errors:', social.errors)
        }
      } catch (socialErr) {
        console.warn('[Meta Callback] Social asset discovery failed:', socialErr)
      }
    }

    // 9. Fire event + activity trail
    await publishAdEvent('provider_connected', {
      employeeId,
      metadata: { provider: 'meta', client_id: targetClientId },
    })
    void logActivity({
      actorId: employeeId,
      entityType: 'client',
      entityId: targetClientId,
      action: 'edited',
      category: 'advertising',
      detail: [{ field: 'meta_connection', from: null, to: 'connected' }],
    })

    return NextResponse.redirect(
      new URL('/dashboard/connections?success=meta_connected', req.url),
    )
  } catch (err: any) {
    console.error('[Meta OAuth Callback]', err)
    return NextResponse.redirect(
      new URL('/dashboard/connections?error=server_error', req.url),
    )
  }
}
