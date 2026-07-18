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
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID
  if (!clientId) {
    return NextResponse.json({ error: 'Google OAuth not configured on this server.' }, { status: 501 })
  }

  // 3. Extract the client_id context
  const url = new URL(req.url)
  const targetClientId = url.searchParams.get('client_id')
  if (!targetClientId) {
    return NextResponse.json({ error: 'Missing target client_id in query params' }, { status: 400 })
  }

  // 4. Construct Redirect URI & State
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || url.origin}/api/auth/google/callback`
  const state = signOAuthState({
    clientId: targetClientId,
    employeeId: user.employeeId,
  })

  // 5. Construct Google OAuth URL
  const scope = 'https://www.googleapis.com/auth/adwords'
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}&access_type=offline&prompt=consent`

  return NextResponse.redirect(authUrl)
}
