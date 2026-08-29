import { resolveBrandingUrl } from '@/lib/utils/branding'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * The workspace favicon, served from OUR origin so the browser can cache it.
 *
 * Why this route exists — DynamicFavicon used to read `favicon_url` straight
 * from `company_settings` with the browser client, on every page load of every
 * route (it mounts in the ROOT layout). Two problems, both measured:
 *
 *  1. EGRESS. The Settings uploader stores the icon as a base64 data URL, and
 *     that row is ~20 KB. A browser query cannot be HTTP-cached, so it was
 *     ~20 KB of Supabase egress per page view, per user, forever — for an
 *     image that changes maybe once a year.
 *
 *  2. It never worked on the public pages anyway. `/i`, `/intake`, `/portal`,
 *     `/start`, `/feed` and `/login` have no session, and `company_settings`
 *     is not readable by the anon role — so the query 401'd and the custom
 *     favicon silently fell back to the default, having still cost a
 *     round-trip. Reading through the service role here fixes that too.
 *
 * Same shape as /api/logo: decode a stored data: URL to real bytes, follow an
 * https URL, and fall back to the static icon so the <link> always resolves to
 * something. That last part is what lets the client set href unconditionally
 * without first probing whether a custom icon exists.
 */
export async function GET() {
  try {
    const admin = createAdminClient()
    const { data } = await admin
      .from('company_settings')
      .select('value, updated_at')
      .eq('key', 'favicon_url')
      .maybeSingle()

    const raw = resolveBrandingUrl(((data as { value?: string } | null)?.value || '').trim())

    if (raw.startsWith('data:image/')) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(raw)
      if (m) {
        return new NextResponse(Buffer.from(m[2], 'base64'), {
          headers: {
            'Content-Type': m[1],
            // A favicon changes on the order of never. An hour of browser
            // cache is what takes this off the per-page-view budget; the
            // route is still dynamic so a change shows up within the hour.
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
    }

    if (/^https?:\/\//.test(raw)) {
      const ts = data?.updated_at ? new Date(data.updated_at).getTime() : Date.now()
      const sep = raw.includes('?') ? '&' : '?'
      return NextResponse.redirect(`${raw}${sep}v=${ts}`, {
        status: 302,
        headers: {
          'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
        }
      })
    }
  } catch (err) {
    console.error('[api/favicon] failed:', err)
  }

  // Nothing configured, or unreadable — hand back the static icon rather than
  // a 204, so a <link rel="icon" href="/api/favicon"> never resolves to blank.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.cirqle.work'
  return NextResponse.redirect(`${baseUrl.replace(/\/$/, '')}/icon.svg`, {
      status: 302,
      headers: {
          'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
      }
  })
}
