import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { enqueueJob } from '@/lib/jobs/engine'

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
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const admin = createAdminClient()

  try {
    // Note: We might read company_settings here to see if sync is enabled globally.
    // For now we assume it is.
    
    // Fetch active ad_projects with sync_enabled = true and an assigned ad_account_id
    const { data: projects, error: projErr } = await admin
      .from('ad_projects')
      .select('id')
      .eq('sync_enabled', true)
      .not('ad_account_id', 'is', null)
      .in('status', ['active', 'paused', 'completed']) // Include recently completed to catch late attribution

    if (projErr) throw projErr
    if (!projects || projects.length === 0) {
      return NextResponse.json({ message: 'No projects require syncing.' })
    }

    let enqueued = 0
    for (const project of projects) {
      await enqueueJob({
        job_type: 'advertising_sync_project',
        payload: { project_id: project.id },
        priority: 'normal'
      })
      enqueued++
    }

    return NextResponse.json({ 
      ok: true, 
      message: `Enqueued ${enqueued} sync jobs` 
    })
  } catch (error: any) {
    console.error('Advertising sync cron failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
