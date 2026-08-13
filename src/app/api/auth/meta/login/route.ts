import { NextRequest, NextResponse } from 'next/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { signOAuthState } from '@/lib/oauth/state'
import { FACEBOOK_URL } from '@/lib/integrations/meta/client'
import { META_OAUTH_SCOPES } from '@/lib/advertising/providers/meta'

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

  // 3. Extract the client_id context (which Cirqle client the assets belong to)
  const url = new URL(req.url)
  const targetClientId = url.searchParams.get('client_id')
  if (!targetClientId) {
    return NextResponse.json({ error: 'Missing target client_id in query params' }, { status: 400 })
  }

  // 4. Construct Redirect URI & State. The callback handler lives at
  //    /api/advertising/oauth/meta/callback — META_REDIRECT_URI must match the
  //    URI registered in the Meta App Dashboard exactly.
  const redirectUri =
    process.env.META_REDIRECT_URI || `${url.origin}/api/advertising/oauth/meta/callback`
  const state = signOAuthState({
    clientId: targetClientId,
    employeeId: user.employeeId,
  })

  // 5. Construct Meta OAuth URL.
  //    Facebook Login for Business apps must use config_id — the permission set
  //    lives on the login configuration; a plain scope= is silently ignored.
  const base = `${FACEBOOK_URL}/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`
  const configId = process.env.META_LOGIN_CONFIG_ID
  const authUrl = configId
    ? `${base}&config_id=${configId}`
    : `${base}&scope=${META_OAUTH_SCOPES.join(',')}`

  return NextResponse.redirect(authUrl)
}
