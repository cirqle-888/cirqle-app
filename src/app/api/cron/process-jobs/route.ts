import { NextResponse } from 'next/server'
import { processJobs } from '@/lib/jobs/worker'
import { createAdminClient } from '@/lib/supabase/server'


export const dynamic = 'force-dynamic'

/**
 * High-frequency Cron Job (e.g., every 1 min) for Queue Processing
 * 
 * Vercel Serverless Functions have a timeout (usually 10s-60s depending on plan).
 * We run the processor for up to 45 seconds to safely dequeue and run jobs.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const workerId = crypto.randomUUID()
  
  try {
    // 1. Requeue stale jobs first
    const admin = createAdminClient()
    await admin.rpc('requeue_stale_jobs', { p_timeout_minutes: 5 })

    // 2. Process jobs for up to 45 seconds
    const maxDurationMs = 45000
    const processed = await processJobs(workerId, maxDurationMs)

    return NextResponse.json({ 
      ok: true, 
      message: `Worker ${workerId} processed ${processed} jobs` 
    })
  } catch (error: any) {
    console.error(`[Worker ${workerId}] Queue processing failed:`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
