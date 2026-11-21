import type { NextRequest } from 'next/server'
import { oauthMetadata } from '@/lib/mcp/oauth'
import { oauthJson, oauthPreflight, requestOrigin } from '@/lib/mcp/oauth-http'

/** OAuth protected-resource metadata for the MCP endpoint (RFC 9728). Served at /.well-known/oauth-protected-resource through a rewrite in next.config.ts. See lib/mcp/oauth.ts. */
export const dynamic = 'force-dynamic'
export function GET(req: NextRequest) { return oauthJson(oauthMetadata(requestOrigin(req.url)).protectedResource) }
export function OPTIONS() { return oauthPreflight() }
