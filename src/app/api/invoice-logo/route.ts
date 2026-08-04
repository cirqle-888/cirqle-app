import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * The invoice logo, always served SAME-ORIGIN.
 *
 * The invoice renders on a white page, so this picks the LIGHT logo — unlike
 * /api/logo, which is dark-first for the app chrome.
 *
 * Why proxy instead of pointing <img> straight at the stored URL: the invoice
 * is rasterised to a canvas for the PDF, so the <img> carries
 * crossorigin="anonymous" (without it the canvas is tainted and toDataURL
 * throws). `logo_url` is a remote https URL on cirqle.work, and a CORS-mode
 * request there fails in the browser — so the image never loaded and both the
 * preview and the downloaded PDF came out with no logo. Streaming the bytes
 * through our own origin removes CORS from the picture entirely.
 *
 * Note this must NOT redirect to the remote URL (as /api/logo does) — the
 * browser follows the redirect and the final response is cross-origin again,
 * which puts the CORS failure right back.
 */
export async function GET() {
  try {
    const admin = createAdminClient()
    const { data: rows } = await admin
      .from('company_settings')
      .select('key, value')
      .in('key', ['logo_url_light', 'logo_url'])

    const settings: Record<string, string> = {}
    ;(rows || []).forEach((s: any) => { settings[s.key] = s.value })

    const logoStr = settings.logo_url_light || settings.logo_url || ''

    if (logoStr.startsWith('data:image/')) {
      const m = logoStr.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
      if (m) {
        return new NextResponse(Buffer.from(m[2], 'base64'), {
          headers: {
            'Content-Type': m[1],
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
    }

    if (/^https?:\/\//.test(logoStr)) {
      const upstream = await fetch(logoStr, { cache: 'no-store' })
      if (upstream.ok) {
        return new NextResponse(await upstream.arrayBuffer(), {
          headers: {
            'Content-Type': upstream.headers.get('content-type') || 'image/png',
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
    }
  } catch (err) {
    console.error('[api/invoice-logo] failed:', err)
  }

  // No logo configured, or it could not be fetched — 204 keeps the <img> quiet
  // instead of rendering a broken-image icon on the invoice.
  return new NextResponse(null, { status: 204 })
}
