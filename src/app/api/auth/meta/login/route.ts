import { NextRequest, NextResponse } from 'next/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { signOAuthState } from '@/lib/oauth/state'

export async function GET(req: NextRequest) {
  // 1. Authenticate user initiating the request
  const user = await loadCurrentUser().catch(() => null)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Fetch credentials
  const clientId = process.env.META_APP_ID || process.env.META_CLIENT_ID
  if (!clientId) {
    return NextResponse.json({ error: 'Meta OAuth not configured on this server.' }, { status: 501 })
  }

  // 3. Extract the client_id context (which workspace the user is connecting for)
  const url = new URL(req.url)
  const targetClientId = url.searchParams.get('client_id')
  if (!targetClientId) {
    return NextResponse.json({ error: 'Missing target client_id in query params' }, { status: 400 })
  }

  // 4. Construct Redirect URI & State
  const redirectUri = process.env.META_REDIRECT_URI || `${url.origin}/api/auth/meta/callback`
  const state = signOAuthState({
    clientId: targetClientId,
    employeeId: user.employeeId,
  })

  // 5. Construct Meta OAuth URL
  const scope = 'ads_management,ads_read,business_management'
  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${scope}`

  return NextResponse.redirect(authUrl)
}
