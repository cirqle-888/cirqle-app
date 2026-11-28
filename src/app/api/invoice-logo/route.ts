import { resolveBrandingUrl } from '@/lib/utils/branding'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * The invoice logo, always served SAME-ORIGIN.
 *
 * The invoice renders on a white page, so this prefers the LIGHT logo — unlike
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
 *
 * Every configured logo is a candidate, tried in order until one loads. The
 * light logo used to be the only one: it pointed at a fingerprinted website
 * build file (/assets/cirqle-logo-<hash>.png), the website was rebuilt, that
 * URL went 404, and every invoice lost its logo while a perfectly good upload
 * sat in `logo_url_dark`. A dead link now falls through to the next logo.
 */
const LOGO_KEYS = ['logo_url_light', 'logo_url', 'logo_url_dark'] as const

export async function GET() {
  try {
    const admin = createAdminClient()
    const { data: rows } = await admin
      .from('company_settings')
      .select('key, value')
      .in('key', [...LOGO_KEYS])

    const settings: Record<string, string> = {}
    ;(rows || []).forEach((s: any) => { settings[s.key] = s.value })

    for (const key of LOGO_KEYS) {
      const logo = await loadLogo(resolveBrandingUrl(settings[key]))
      if (logo) {
        return new NextResponse(logo.body, {
          headers: {
            'Content-Type': logo.type,
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
    }
  } catch (err) {
    console.error('[api/invoice-logo] failed:', err)
  }

  // No logo configured, or none could be fetched — 204 keeps the <img> quiet
  // instead of rendering a broken-image icon on the invoice.
  return new NextResponse(null, { status: 204 })
}

/** The logo's bytes, or null when it is not set, not an image, or unreachable. */
async function loadLogo(url: string): Promise<{ body: ArrayBuffer | Uint8Array<ArrayBuffer>; type: string } | null> {
  if (!url) return null

  if (url.startsWith('data:image/')) {
    const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/)
    return m ? { body: new Uint8Array(Buffer.from(m[2], 'base64')), type: m[1] } : null
  }

  if (/^https?:\/\//.test(url)) {
    try {
      const upstream = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      const type = upstream.headers.get('content-type') || ''
      // A missing file on a website often answers 200 with its HTML 404 page;
      // only an actual image counts.
      if (upstream.ok && type.startsWith('image/')) {
        return { body: await upstream.arrayBuffer(), type }
      }
      console.warn(`[api/invoice-logo] ${url} → ${upstream.status} ${type}; trying the next logo`)
    } catch (err) {
      console.warn(`[api/invoice-logo] ${url} unreachable; trying the next logo`, err)
    }
  }

  return null
}
