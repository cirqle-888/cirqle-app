import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { publishAdEvent } from '@/lib/advertising/events'

/**
 * Meta OAuth callback handler.
 * Registered redirect URI: META_REDIRECT_URI env var
 * (https://app.cirqle.work/api/advertising/oauth/meta/callback)
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  const errorReason = url.searchParams.get('error_reason')

  if (error || !code) {
    const msg = errorReason === 'user_denied' ? 'auth_denied' : 'auth_failed'
    return NextResponse.redirect(new URL(`/dashboard/advertising/integrations?error=${msg}`, req.url))
  }

  const clientId = process.env.META_APP_ID || process.env.META_CLIENT_ID
  const clientSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL('/dashboard/advertising/integrations?error=not_configured', req.url))
  }

  try {
    // 1. Decode state
    const state = JSON.parse(Buffer.from(stateParam || '', 'base64').toString('utf-8'))
    const { clientId: targetClientId, employeeId } = state

    if (!targetClientId) throw new Error('Missing target client ID in state')

    // 2. Exchange code for short-lived token
    const redirectUri = process.env.META_REDIRECT_URI || `${url.origin}/api/advertising/oauth/meta/callback`
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&client_secret=${clientSecret}` +
      `&code=${code}`
    )
    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) throw new Error(tokenData.error?.message || 'Token exchange failed')

    // 3. Exchange for long-lived token (~60 days)
    const longLivedRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${clientId}` +
      `&client_secret=${clientSecret}` +
      `&fb_exchange_token=${tokenData.access_token}`
    )
    const longLivedData = await longLivedRes.json()

    const accessToken = longLivedData.access_token || tokenData.access_token
    const expiresIn = longLivedData.expires_in || 60 * 60 * 24 * 60 // 60-day default
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // 4. Persist connection
    const admin = createAdminClient()
    const { error: dbError } = await admin
      .from('provider_connections')
      .upsert(
        {
          client_id: targetClientId,
          provider: 'meta',
          access_token: accessToken,
          token_expires_at: expiresAt,
          status: 'active',
          last_auth_at: new Date().toISOString(),
          connected_by: employeeId,
        },
        { onConflict: 'client_id,provider' }
      )

    if (dbError) throw dbError

    // 5. Auto-discover ad accounts
    try {
      const accountsRes = await fetch(
        `https://graph.facebook.com/v19.0/me/adaccounts` +
        `?fields=account_id,name,currency,timezone_name,business` +
        `&access_token=${accessToken}`
      )
      const accountsData = await accountsRes.json()

      if (accountsRes.ok && Array.isArray(accountsData.data)) {
        const { data: conn } = await admin
          .from('provider_connections')
          .select('id')
          .eq('client_id', targetClientId)
          .eq('provider', 'meta')
          .single()

        if (conn) {
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
                  { onConflict: 'connection_id,business_id' }
                )
                .select('id')
                .single()
              businessRowId = biz?.id ?? null
            }

            // Upsert ad account
            await admin
              .from('ad_accounts')
              .upsert(
                {
                  connection_id: conn.id,
                  business_id: businessRowId,
                  client_id: targetClientId,
                  provider: 'meta',
                  account_id: acc.account_id,
                  name: acc.name,
                  currency: acc.currency,
                  timezone: acc.timezone_name,
                  is_active: true,
                },
                { onConflict: 'provider,account_id' }
              )
          }
        }
      }
    } catch (discoveryErr) {
      // Non-fatal: account discovery fails silently; user can refresh manually
      console.warn('[Meta Callback] Ad account discovery failed:', discoveryErr)
    }

    // 6. Fire event
    await publishAdEvent('provider_connected', {
      employeeId,
      metadata: { provider: 'meta', client_id: targetClientId },
    })

    return NextResponse.redirect(
      new URL('/dashboard/advertising/integrations?success=meta_connected', req.url)
    )
  } catch (err: any) {
    console.error('[Meta OAuth Callback]', err)
    return NextResponse.redirect(
      new URL('/dashboard/advertising/integrations?error=server_error', req.url)
    )
  }
}
