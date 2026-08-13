/**
 * Alias callback so a Meta app whose "Valid OAuth Redirect URI" is
 * https://<app>/api/auth/meta/callback works identically to the canonical
 * handler at /api/advertising/oauth/meta/callback.
 *
 * Why this exists: the login route historically defaulted its redirect_uri to
 * /api/auth/meta/callback while the handler lived under /api/advertising/...,
 * so any Meta app registered with the auth-path URI 404'd on return. This
 * re-export makes BOTH paths valid — set META_REDIRECT_URI to whichever URL is
 * registered in the Meta App Dashboard and it will match at token-exchange time.
 */
export { GET } from '@/app/api/advertising/oauth/meta/callback/route'

export const dynamic = 'force-dynamic'
