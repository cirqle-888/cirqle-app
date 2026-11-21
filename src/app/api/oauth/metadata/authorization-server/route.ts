import type { NextRequest } from 'next/server'
import { oauthMetadata } from '@/lib/mcp/oauth'
import { oauthJson, oauthPreflight, requestOrigin } from '@/lib/mcp/oauth-http'

/** OAuth authorization-server metadata (RFC 8414). Served at /.well-known/oauth-authorization-server through a rewrite in next.config.ts. See lib/mcp/oauth.ts. */
export const dynamic = 'force-dynamic'
export function GET(req: NextRequest) { return oauthJson(oauthMetadata(requestOrigin(req.url)).authorizationServer) }
export function OPTIONS() { return oauthPreflight() }
