import type { NextRequest } from 'next/server'
import { registerClient } from '@/lib/mcp/oauth'
import { oauthJson, oauthPreflight } from '@/lib/mcp/oauth-http'

/**
 * Dynamic client registration (RFC 7591) for AI apps connecting to the MCP
 * endpoint. Stateless: the client id is a signed copy of the registration.
 * Registering grants nothing; a Cirqle admin must still press Allow.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let meta: { redirect_uris?: unknown; client_name?: unknown } = {}
  try { meta = await req.json() } catch { return oauthJson({ error: 'invalid_client_metadata', error_description: 'Send JSON.' }, 400) }
  const now = Math.floor(Date.now() / 1000)
  const r = registerClient(meta, now)
  if (!r.ok) return oauthJson({ error: r.error, error_description: r.description }, r.error === 'server_error' ? 500 : 400)
  return oauthJson({
    client_id: r.clientId,
    client_id_issued_at: now,
    client_name: r.name,
    redirect_uris: r.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201)
}

export function OPTIONS() { return oauthPreflight() }
