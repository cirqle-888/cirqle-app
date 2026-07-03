import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { enqueueJob } from '@/lib/jobs/engine'
import { discoverAccountCampaigns } from '@/lib/advertising/discovery'

export const dynamic = 'force-dynamic'

/**
 * Hourly Cron Job for Syncing Advertising Metrics
 *
 * It iterators through active campaigns and enqueues jobs for them.
 * Actual processing is done by the process-jobs background worker.
 */
export async function GET(req: Request) {
  // Validate cron secret if provided
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const admin = createAdminClient()

  try {
    // Note: We might read company_settings here to see if sync is enabled globally.
    // For now we assume it is.

    // 0. Discovery pass — refresh the campaign registry for every active account
    //    so newly-created Meta campaigns surface as "unmapped". Best-effort: a
    //    failing account is logged inside discoverAccountCampaigns and skipped.
    let discovered = 0
    const { data: accounts } = await admin
      .from('ad_accounts')
      .select('id')
      .eq('is_active', true)
    for (const acc of accounts ?? []) {
      const r = await discoverAccountCampaigns(admin, acc.id, 'scheduled')
      discovered += r.discovered
    }

    // Fetch active ad_projects with sync_enabled = true and an assigned ad_account_id.
    // select('*') so the archived_at filter below stays safe before its migration.
    const { data: projects, error: projErr } = await admin
      .from('ad_projects')
      .select('*')
      .eq('sync_enabled', true)
      .not('ad_account_id', 'is', null)
      .in('status', ['active', 'paused', 'completed']) // Include recently completed to catch late attribution

    if (projErr) throw projErr

    // Archived / soft-deleted campaigns don't sync (JS-side so a missing
    // archived_at column pre-migration can't break the whole cron).
    const live = (projects ?? []).filter((p: any) => !p.deleted_at && !p.archived_at)

    let enqueued = 0
    for (const project of live) {
      await enqueueJob({
        job_type: 'advertising_sync_project',
        payload: { project_id: project.id },
        priority: 'normal'
      })
      enqueued++
    }

    return NextResponse.json({
      ok: true,
      discovered,
      message: `Discovered ${discovered} campaigns; enqueued ${enqueued} sync jobs`,
    })
  } catch (error: any) {
    console.error('Advertising sync cron failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
