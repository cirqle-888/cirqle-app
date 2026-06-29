/**
 * Enterprise Background Jobs Engine
 * 
 * Supports queuing, prioritizing, DAG dependencies, and processing background jobs.
 */

import { createAdminClient } from '@/lib/supabase/server'

import { publishAdEvent } from '@/lib/advertising/events'

export type JobPriority = 'high' | 'normal' | 'low'
export type JobStatus = 'waiting' | 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'retrying' | 'cancelled' | 'dead_letter'

export interface SystemJob {
  id?: string
  job_type: string
  priority?: JobPriority
  status?: JobStatus
  payload: any
  max_attempts?: number
  parent_job_id?: string
  depends_on_job_id?: string
  retry_delay_seconds?: number
  metadata?: any
}

export interface DequeuedJob extends SystemJob {
  id: string
  attempts: number
  queued_at: string
  error_log: string
}

/**
 * Enqueues a generic job into the system.
 */
export async function enqueueJob(job: SystemJob): Promise<string> {
  const supabase = createAdminClient()
  
  const { data, error } = await supabase
    .from('system_jobs')
    .insert({
      job_type: job.job_type,
      priority: job.priority || 'normal',
      status: job.status || 'pending',
      payload: job.payload,
      max_attempts: job.max_attempts || 3,
      parent_job_id: job.parent_job_id || null,
      depends_on_job_id: job.depends_on_job_id || null,
      retry_delay_seconds: job.retry_delay_seconds || 60,
      metadata: job.metadata || {}
    })
    .select('id')
    .single()

  if (error) {
    console.error('[Jobs] Failed to enqueue:', error)
    throw new Error('Job enqueue failed')
  }

  await publishAdEvent('job_created', { metadata: { job_id: data.id, job_type: job.job_type } })
  return data.id
}

/**
 * Atomically dequeues jobs using PostgreSQL FOR UPDATE SKIP LOCKED
 */
export async function dequeueJobs(workerId: string, maxJobs: number = 5): Promise<DequeuedJob[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('dequeue_jobs', {
    p_worker_id: workerId,
    p_max_jobs: maxJobs
  })

  if (error) {
    console.error('[Jobs] Failed to dequeue:', error)
    return []
  }

  const jobs = data as DequeuedJob[]
  for (const job of jobs) {
    await publishAdEvent(job.attempts > 0 ? 'retry_started' : 'job_started', { 
      metadata: { job_id: job.id, job_type: job.job_type, attempts: job.attempts } 
    })
  }

  return jobs
}

/**
 * Marks a job as completed
 */
export async function completeJob(job: DequeuedJob, metadataUpdates?: any): Promise<void> {
  const supabase = createAdminClient()
  
  let updateData: any = {
    status: 'completed',
    finished_at: new Date().toISOString(),
    locked_by: null,
    locked_at: null
  }
  
  if (metadataUpdates) {
    updateData.metadata = { ...job.metadata, ...metadataUpdates }
  }

  const { error } = await supabase
    .from('system_jobs')
    .update(updateData)
    .eq('id', job.id)

  if (error) console.error(`[Jobs] Failed to complete job ${job.id}:`, error)
  else await publishAdEvent(job.attempts > 0 ? 'retry_completed' : 'job_completed', { metadata: { job_id: job.id, job_type: job.job_type } })
}

/**
 * Fails a job, triggering exponential backoff or dead letter queue
 */
export async function failJob(job: DequeuedJob, errorMsg: string): Promise<void> {
  const supabase = createAdminClient()
  
  const attempts = job.attempts || 0
  const maxAttempts = job.max_attempts || 3
  const baseDelay = job.retry_delay_seconds || 60

  const newAttempts = attempts + 1
  const isDeadLetter = newAttempts >= maxAttempts
  
  const nextRun = new Date()
  nextRun.setSeconds(nextRun.getSeconds() + (baseDelay * Math.pow(2, attempts)))
  
  const { error } = await supabase
    .from('system_jobs')
    .update({
      status: isDeadLetter ? 'dead_letter' : 'retrying',
      locked_by: null,
      locked_at: null,
      attempts: newAttempts,
      queued_at: nextRun.toISOString(),
      finished_at: isDeadLetter ? new Date().toISOString() : null,
      error_log: errorMsg
    })
    .eq('id', job.id)

  if (error) console.error(`[Jobs] Failed to fail job ${job.id}:`, error)
  else await publishAdEvent('job_failed', { metadata: { job_id: job.id, job_type: job.job_type, error: errorMsg, is_dead_letter: isDeadLetter } })
}

/**
 * Updates heartbeat for a running job to prevent it from being re-queued
 */
export async function heartbeatJob(jobId: string): Promise<void> {
  const supabase = createAdminClient()
  
  const { error } = await supabase
    .from('system_jobs')
    .update({ locked_at: new Date().toISOString() })
    .eq('id', jobId)

  if (error) console.error(`[Jobs] Failed to heartbeat job ${jobId}:`, error)
}
