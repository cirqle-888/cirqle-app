import { NextRequest, NextResponse } from 'next/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createCirqleMcpServer } from '@/lib/mcp/server'
import { createAdminClient } from '@/lib/supabase/server'
import { accessTokenSubject } from '@/lib/mcp/oauth'

/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 *
 *   POST /api/mcp   JSON-RPC messages (initialize, tools/list, tools/call …)
 *   GET  /api/mcp   server-initiated stream; unused in stateless mode → 405
 *   DELETE /api/mcp session teardown; no sessions in stateless mode → 405
 *
 * Auth, either of:
 *   · `Authorization: Bearer <MCP_API_TOKEN>`: one shared secret, as before
 *     (Claude Code, Codex, Gemini CLI, mcp-remote).
 *   · an OAuth access token from /api/oauth/token (lib/mcp/oauth.ts): what
 *     Claude on the web, phone and desktop get from the Connect button. Only
 *     a Cirqle admin can approve one, and it stops working when that person
 *     is deactivated or MCP_API_TOKEN changes.
 * Fails closed when MCP_API_TOKEN is unset (it also keys the OAuth tokens).
 * A 401 points at the OAuth metadata so AI apps can start sign-in.
 *
 * Stateless on purpose: each request builds a fresh server + transport, so it
 * works on Vercel's serverless runtime where nothing survives between calls.
 * `enableJsonResponse` returns plain JSON instead of an SSE stream — the tools
 * are short request/response calls, nothing needs server push.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function authorized(req: NextRequest): Promise<boolean> {
  const token = process.env.MCP_API_TOKEN
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  const got = header.replace(/^Bearer\s+/i, '').trim()
  if (!got) return false
  if (got === token) return true
  const employeeId = accessTokenSubject(got, Math.floor(Date.now() / 1000))
  if (!employeeId) return false
  const { data } = await createAdminClient().from('employees').select('id')
    .eq('id', employeeId).eq('is_active', true).eq('is_archived', false).maybeSingle()
  return !!data
}

function unauthorized(req: NextRequest) {
  const metadata = `${new URL(req.url).origin}/.well-known/oauth-protected-resource/api/mcp`
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
    { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="cirqle-mcp", resource_metadata="${metadata}"` } },
  )
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized(req)
  const server = createCirqleMcpServer()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(req)
  } finally {
    // Nothing persists between invocations; release the per-request server.
    void transport.close().catch(() => {})
  }
}

export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized(req)
  return NextResponse.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: stateless server, use POST.' }, id: null }, { status: 405, headers: { Allow: 'POST' } })
}

export const DELETE = GET
