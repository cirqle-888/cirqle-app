import { NextResponse } from 'next/server'

/** Discovery and registration are read by AI apps' servers and, sometimes, browsers. */
export const OAUTH_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version',
}

export function oauthJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...OAUTH_CORS, 'Cache-Control': 'no-store' } })
}

export function oauthPreflight() {
  return new NextResponse(null, { status: 204, headers: OAUTH_CORS })
}

/** The public origin the request came in on (https://app.cirqle.work in production). */
export function requestOrigin(url: string): string {
  return new URL(url).origin
}
