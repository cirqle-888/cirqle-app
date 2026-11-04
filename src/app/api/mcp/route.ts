import { NextRequest, NextResponse } from 'next/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createCirqleMcpServer } from '@/lib/mcp/server'

/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 *
 *   POST /api/mcp   JSON-RPC messages (initialize, tools/list, tools/call …)
 *   GET  /api/mcp   server-initiated stream; unused in stateless mode → 405
 *   DELETE /api/mcp session teardown; no sessions in stateless mode → 405
 *
 * Auth: `Authorization: Bearer <MCP_API_TOKEN>`. Same model as /api/shortcut —
 * one shared secret, service-role data access, so the token IS the gate and
 * the route fails closed when the env var is unset (see the token check:
 * an unset secret never equals a header, and an empty header never passes).
 *
 * Stateless on purpose: each request builds a fresh server + transport, so it
 * works on Vercel's serverless runtime where nothing survives between calls.
 * `enableJsonResponse` returns plain JSON instead of an SSE stream — the tools
 * are short request/response calls, nothing needs server push.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function authorized(req: NextRequest): boolean {
  const token = process.env.MCP_API_TOKEN
  if (!token) return false
  const header = req.headers.get('authorization') || ''
  const got = header.replace(/^Bearer\s+/i, '').trim()
  return got.length > 0 && got === token
}

function unauthorized() {
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
    { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="cirqle-mcp"' } },
  )
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return unauthorized()
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
  if (!authorized(req)) return unauthorized()
  return NextResponse.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: stateless server, use POST.' }, id: null }, { status: 405, headers: { Allow: 'POST' } })
}

export const DELETE = GET
