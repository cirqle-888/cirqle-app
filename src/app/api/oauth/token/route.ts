import type { NextRequest } from 'next/server'
import { exchange } from '@/lib/mcp/oauth'
import { oauthJson, oauthPreflight } from '@/lib/mcp/oauth-http'

/**
 * OAuth token endpoint: authorization_code (PKCE S256) and refresh_token.
 * Accepts form-encoded bodies (RFC 6749) and, leniently, JSON.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const type = req.headers.get('content-type') || ''
  let form: Record<string, string> = {}
  try {
    if (type.includes('application/json')) {
      const j = await req.json() as Record<string, unknown>
      form = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? '')]))
    } else {
      form = Object.fromEntries(new URLSearchParams(await req.text()))
    }
  } catch {
    return oauthJson({ error: 'invalid_request', error_description: 'Unreadable body.' }, 400)
  }
  const r = exchange(form, Math.floor(Date.now() / 1000))
  if (!r.ok) return oauthJson({ error: r.error, error_description: r.description }, r.error === 'server_error' ? 500 : r.error === 'invalid_client' ? 401 : 400)
  const { sub: _sub, ...body } = r.body
  void _sub
  return oauthJson(body)
}

export function OPTIONS() { return oauthPreflight() }
