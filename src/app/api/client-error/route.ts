import { NextResponse } from 'next/server'
import { loadCurrentUser } from '@/lib/permissions/check'

/**
 * Browser-side crash reports from components/errors/app-error-screen.
 *
 * Written to the server log only (Vercel → Logs, filter "[client-error]"), no
 * table: the point is to see WHAT broke the next time someone gets the error
 * screen. Behind the normal session check in middleware, so only signed-in
 * staff can write here; every field is truncated.
 */
export const dynamic = 'force-dynamic'

const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined)

export async function POST(req: Request) {
  let body: Record<string, unknown> = {}
  try {
    const text = await req.text()
    if (text.length > 16_000) return new NextResponse(null, { status: 413 })
    body = JSON.parse(text)
  } catch {
    return new NextResponse(null, { status: 400 })
  }
  const me = await loadCurrentUser().catch(() => null)
  console.error('[client-error]', JSON.stringify({
    who: me?.cqid ?? null,
    boundary: cut(body.boundary, 20),
    stale: body.stale === true,
    name: cut(body.name, 100),
    message: cut(body.message, 1000),
    digest: cut(body.digest, 100),
    url: cut(body.url, 500),
    userAgent: cut(body.userAgent, 300),
    stack: cut(body.stack, 4000),
  }))
  return new NextResponse(null, { status: 204 })
}
