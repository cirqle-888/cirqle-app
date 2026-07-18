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

  const clientId = process.env.GOOGLE_ADS_CLIENT_ID
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Google OAuth not configured on this server.' }, { status: 501 })
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

    // 2. Exchange code for access & refresh tokens
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || url.origin}/api/auth/google/callback`
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    })

    const tokenData = await tokenRes.json()
    if (!tokenRes.ok) {
      throw new Error(tokenData.error_description || 'Token exchange failed')
    }

    const { access_token, refresh_token, expires_in } = tokenData
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString()

    // 3. Save to database
    const supabase = createAdminClient()
    const payload: any = {
      client_id: targetClientId,
      provider: 'google',
      access_token,
      token_expires_at: expiresAt,
      status: 'active',
      last_auth_at: new Date().toISOString(),
      connected_by: employeeId
    }

    // Google only sends a refresh token on the first consent prompt. 
    // If they re-auth without revoking, refresh_token is omitted.
    if (refresh_token) {
      payload.refresh_token = refresh_token
    }

    const { error: dbError } = await supabase
      .from('provider_connections')
      .upsert(payload, { onConflict: 'client_id,provider' })

    if (dbError) {
      throw dbError
    }

    // 4. Fire Event
    await publishAdEvent('provider_connected', {
      employeeId,
      metadata: { provider: 'google', client_id: targetClientId }
    })

    return NextResponse.redirect(new URL('/dashboard/advertising/integrations?success=google_connected', req.url))
  } catch (err: any) {
    console.error('[Google Callback Error]', err)
    return NextResponse.redirect(new URL('/dashboard/advertising/integrations?error=server_error', req.url))
  }
}
