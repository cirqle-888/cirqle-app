import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server'

/**
 * POST /api/figma/login — one-time sign-in for the Cirqle Studio plugin.
 *
 * The plugin used to ask every designer to paste the workspace's shared
 * `offer_sheet_secret`. Instead, an employee signs in ONCE with their own
 * Cirqle credentials (email or CQID + password); on success this route hands
 * back that same workspace secret plus the employee's id and CQID. The
 * plugin stores those — never the password, and never the person's name —
 * and every offer it saves is attributed to whoever saved it (see the task
 * creation in ../campaign/route.ts).
 *
 * The password is verified against Supabase auth exactly like the web login
 * (signInWithPassword); no session is persisted server-side.
 */

export const dynamic = 'force-dynamic'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as { identifier?: string; password?: string } | null
    const identifier = (body?.identifier || '').trim()
    const password = body?.password || ''
    if (!identifier || !password) {
      return NextResponse.json(
        { ok: false, error: 'Enter your email (or CQID) and password.' },
        { status: 400, headers: CORS_HEADERS },
      )
    }

    const admin = createAdminClient()

    // CQID → email, mirroring the web login's resolver.
    let email = identifier.toLowerCase()
    if (!identifier.includes('@')) {
      const cqid = identifier.toUpperCase().replace(/\s+/g, '')
      const { data } = await admin.from('employees').select('email').ilike('cqid', cqid).maybeSingle()
      const resolved = (data as { email?: string } | null)?.email
      if (!resolved) {
        return NextResponse.json(
          { ok: false, error: 'No account found for that CQID. Try your email instead.' },
          { status: 401, headers: CORS_HEADERS },
        )
      }
      email = resolved.toLowerCase()
    }

    // Verify the password the same way the web login does — against Supabase
    // auth, with no persisted session (this is a one-shot check).
    const auth = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const { error: signInError } = await auth.auth.signInWithPassword({ email, password })
    if (signInError) {
      return NextResponse.json(
        { ok: false, error: 'Wrong email/CQID or password.' },
        { status: 401, headers: CORS_HEADERS },
      )
    }

    // CQID, not the person's name: the plugin shows this in a panel that
    // sits open on a shared screen all day, and a staff ID identifies the
    // signed-in user without putting their name on display.
    const { data: employeeRow } = await admin
      .from('employees')
      .select('id, cqid')
      .ilike('email', email)
      .maybeSingle()
    const employee = employeeRow as { id: string; cqid: string | null } | null

    const { data: secretRow } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', 'offer_sheet_secret')
      .maybeSingle()
    const secret = ((secretRow as { value?: string } | null)?.value || '').trim()
    if (!secret) {
      return NextResponse.json(
        { ok: false, error: 'The workspace has no Offer Intake secret yet — set one in Apps → Offer Intake first.' },
        { status: 500, headers: CORS_HEADERS },
      )
    }

    return NextResponse.json(
      {
        ok: true,
        token: secret,
        user: { id: employee?.id || null, cqid: employee?.cqid || null },
      },
      { headers: CORS_HEADERS },
    )
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Login failed.' },
      { status: 500, headers: CORS_HEADERS },
    )
  }
}
