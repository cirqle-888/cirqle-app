import { dequeueJobs, completeJob, failJob, heartbeatJob, DequeuedJob } from './engine'
import { syncProjectWorker } from '@/lib/advertising/workers/sync'
import { refreshTokenWorker } from '@/lib/advertising/workers/token'
import { sendNotificationWorker } from '@/lib/advertising/workers/notifications'
import { generateReportWorker } from '@/lib/advertising/workers/reports'
import {
  socialLeadsBackfillWorker,
  socialPublishPostWorker,
  socialSyncAccountWorker,
} from '@/lib/integrations/meta/workers'

// Map of job_type to handler function
const JOB_HANDLERS: Record<string, (job: DequeuedJob) => Promise<any>> = {
  'advertising_sync_project': syncProjectWorker,
  'advertising_refresh_token': refreshTokenWorker,
  'advertising_send_notification': sendNotificationWorker,
  'advertising_generate_report': generateReportWorker,
  'social_sync_account': socialSyncAccountWorker,
  'social_publish_post': socialPublishPostWorker,
  'social_leads_backfill': socialLeadsBackfillWorker,
}

export async function processJobs(workerId: string, maxDurationMs: number = 45000) {
  const startTime = Date.now()
  let processed = 0
  
  while (Date.now() - startTime < maxDurationMs) {
    const jobs = await dequeueJobs(workerId, 2)
    if (!jobs || jobs.length === 0) {
      break // Queue empty, we can safely exit this cron tick
    }
    
    // Process the batch concurrently
    await Promise.all(jobs.map(async (job) => {
      try {
        const handler = JOB_HANDLERS[job.job_type]
        if (!handler) throw new Error(`Unknown job_type: ${job.job_type}`)
        
        // Start a heartbeat interval for this job
        const heartbeatInterval = setInterval(() => {
          heartbeatJob(job.id).catch(console.error)
        }, 10000)
        
        try {
          const metadataUpdates = await handler(job)
          await completeJob(job, metadataUpdates)
        } finally {
          clearInterval(heartbeatInterval)
        }
      } catch (err: any) {
        console.error(`[Worker ${workerId}] Job ${job.id} failed:`, err)
        await failJob(job, err.message || 'Unknown error')
      }
      processed++
    }))
  }
  
  return processed
}
