import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const admin = createAdminClient()
    const { data: settingsRows } = await admin
      .from('company_settings')
      .select('key, value')
      .in('key', ['logo_url', 'logo_url_dark'])

    const settings: Record<string, string> = {}
    ;(settingsRows || []).forEach((s: any) => { settings[s.key] = s.value })

    const logoStr = settings.logo_url_dark || settings.logo_url || ''

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
      return NextResponse.redirect(logoStr)
    }
  } catch (err) {}

  return NextResponse.redirect('https://app.cirqle.work/icon.svg')
}
