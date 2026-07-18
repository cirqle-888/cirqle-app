import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { publishAdEvent } from '@/lib/advertising/events'
import { loadCurrentUser } from '@/lib/permissions/check'
import { verifyOAuthState } from '@/lib/oauth/state'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const stateParam = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error || !code) {
    return NextResponse.redirect(new URL('/dashboard/advertising/integrations?error=auth_failed', req.url))
  }

  const clientId = process.env.META_APP_ID || process.env.META_CLIENT_ID
  const clientSecret = process.env.META_APP_SECRET || process.env.META_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Meta OAuth not configured on this server.' }, { status: 501 })
  }

  try {
    // 1. Require a signed-in employee session (the person completing the flow)
    const user = await loadCurrentUser().catch(() => null)
    if (!user) {
      return NextResponse.redirect(new URL('/dashboard/advertising/integrations?error=not_signed_in', req.url))
    }

    // 2. Verify HMAC-signed state (rejects forged/expired states)
    const state = verifyOAuthState<{ clientId: string; employeeId: string }>(stateParam)
    if (!state) {
      return NextResponse.redirect(new URL('/dashboard/advertising/integrations?error=invalid_state', req.url))
    }
    const targetClientId = state.clientId
    const employeeId = user.employeeId // attribute to the live session, not the state payload

    if (!targetClientId) {
      throw new Error('Missing target client ID in state')
    }

    // 2. Exchange code for access token
    const redirectUri = process.env.META_REDIRECT_URI || `${url.origin}/api/auth/meta/callback`
    const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${clientSecret}&code=${code}`)
    const tokenData = await tokenRes.json()

    if (!tokenRes.ok) {
      throw new Error(tokenData.error?.message || 'Token exchange failed')
    }

    // 3. Exchange short-lived token for a long-lived token
    const longLivedRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${tokenData.access_token}`)
    const longLivedData = await longLivedRes.json()
    
    const accessToken = longLivedData.access_token || tokenData.access_token
    const expiresIn = longLivedData.expires_in || (60 * 60 * 24 * 60) // Default 60 days if not provided
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // 4. Save to database
    const supabase = createAdminClient()
    const { error: dbError } = await supabase
      .from('provider_connections')
      .upsert({
        client_id: targetClientId,
        provider: 'meta',
        access_token: accessToken,
        token_expires_at: expiresAt,
        status: 'active',
        last_auth_at: new Date().toISOString(),
        connected_by: employeeId
      }, { onConflict: 'client_id,provider' })

    if (dbError) {
      throw dbError
    }

    // 5. Fire Event
    await publishAdEvent('provider_connected', {
      employeeId,
      metadata: { provider: 'meta', client_id: targetClientId }
    })

    return NextResponse.redirect(new URL('/dashboard/advertising/integrations?success=meta_connected', req.url))
  } catch (err: any) {
    console.error('[Meta Callback Error]', err)
    return NextResponse.redirect(new URL('/dashboard/advertising/integrations?error=server_error', req.url))
  }
}
