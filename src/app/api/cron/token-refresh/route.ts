import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { enqueueJob } from '@/lib/jobs/engine'

export const dynamic = 'force-dynamic'

/**
 * Daily Cron Job for Token Refresh
 *
 * Enqueues advertising_refresh_token jobs for connections expiring within 7 days.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  const admin = createAdminClient()

  try {
    const nextWeek = new Date()
    nextWeek.setDate(nextWeek.getDate() + 7)

    const { data: connections, error } = await admin
      .from('provider_connections')
      .select('id')
      .eq('status', 'active')
      .not('token_expires_at', 'is', null)
      .lte('token_expires_at', nextWeek.toISOString())

    if (error) throw error
    if (!connections || connections.length === 0) {
      return NextResponse.json({ message: 'No tokens require refreshing.' })
    }

    let enqueued = 0
    for (const conn of connections) {
      await enqueueJob({
        job_type: 'advertising_refresh_token',
        payload: { connection_id: conn.id },
        priority: 'high'
      })
      enqueued++
    }

    return NextResponse.json({ 
      ok: true, 
      message: `Enqueued ${enqueued} token refresh jobs` 
    })
  } catch (error: any) {
    console.error('Token refresh cron failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
