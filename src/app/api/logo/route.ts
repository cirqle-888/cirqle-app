import { resolveBrandingUrl } from '@/lib/utils/branding'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const admin = createAdminClient()
    const { data: settingsRows } = await admin
      .from('company_settings')
      .select('key, value, updated_at')
      .in('key', ['logo_url', 'logo_url_dark'])

    const settings: Record<string, string> = {}
    const updatedAts: Record<string, string> = {}
    ;(settingsRows || []).forEach((s: any) => { 
      settings[s.key] = s.value 
      updatedAts[s.key] = s.updated_at 
    })

    const logoStr = resolveBrandingUrl(settings.logo_url_dark || settings.logo_url) || ''
    const lastUpdated = updatedAts.logo_url_dark || updatedAts.logo_url || ''

    if (logoStr.startsWith('data:image/')) {
      const matches = logoStr.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/)
      if (matches && matches.length === 3) {
        const contentType = matches[1]
        const buffer = Buffer.from(matches[2], 'base64')
        return new NextResponse(buffer, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600',
          },
        })
      }
    }

    if (logoStr.startsWith('http')) {
      const ts = lastUpdated ? new Date(lastUpdated).getTime() : Date.now()
      const sep = logoStr.includes('?') ? '&' : '?'
      return NextResponse.redirect(`${logoStr}${sep}v=${ts}`, {
        status: 302,
        headers: {
          'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400'
        }
      })
    }
  } catch (err) {}

  return NextResponse.redirect('https://app.cirqle.work/icon.svg')
}
