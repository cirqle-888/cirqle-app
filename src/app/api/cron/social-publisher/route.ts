import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { publishSocialPost } from '@/lib/integrations/meta/publish'
import { logCronRun } from '@/lib/cron/log'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * Social publisher — publishes due scheduled posts. Runs every 10 minutes
 * (vercel.json): Instagram has NO native scheduling, so this queue IS the
 * scheduler; publish accuracy = cron cadence.
 *
 * Concurrency-safe: publishSocialPost claims each post with a status CAS
 * (scheduled → publishing), so overlapping runs cannot double-publish.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const admin = createAdminClient()
  const startedAt = Date.now()
  const budgetMs = 240_000

  let published = 0
  let failed = 0
  const errors: string[] = []

  try {
    const { data: due, error } = await admin
      .from('social_posts')
      .select('id, scheduled_at')
      .eq('status', 'scheduled')
      .is('deleted_at', null)
      // Never touch something Meta already has. A row carrying an
      // external_media_id has been handed over once; publishing it again would
      // put a duplicate on a client's account, and no status CAS protects
      // against that because the second publish is a fresh, legitimate-looking
      // request.
      .is('external_media_id', null)
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(25)

    if (error) throw error

    for (const post of due ?? []) {
      if (Date.now() - startedAt > budgetMs) break // next run picks it up
      const result = await publishSocialPost(admin, post.id)
      if (result.ok) published++
      else {
        failed++
        if (result.error) errors.push(`${post.id}: ${result.error}`)
      }
    }

    // Also recover posts stuck in 'publishing' for >15 min (a killed invocation).
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    await admin
      .from('social_posts')
      .update({ status: 'scheduled' })
      .eq('status', 'publishing')
      .lt('updated_at', staleCutoff)
      .then(null, () => {})

    const summary = { due: (due ?? []).length, published, failed, errors: errors.slice(0, 5) }
    await logCronRun(admin, 'social-publisher', failed === 0, summary)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err: any) {
    await logCronRun(admin, 'social-publisher', false, { published, failed }, err?.message)
    return NextResponse.json({ error: err?.message }, { status: 500 })
  }
}
