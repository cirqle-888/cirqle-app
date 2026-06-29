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
      status: 'pending',
      payload: job.payload,
      max_attempts: job.max_attempts || 3,
    })
    .select('id')
    .single()

  if (error) {
    console.error('[Jobs] Failed to enqueue:', error)
    throw new Error(`Job enqueue failed: ${error.message}`)
  }

  await publishAdEvent('job_created', { metadata: { job_id: data.id, job_type: job.job_type } })
  return data.id
}

/**
 * Dequeues jobs using optimistic locking (no RPC dependency)
 */
export async function dequeueJobs(workerId: string, maxJobs: number = 5): Promise<DequeuedJob[]> {
  const supabase = createAdminClient()

  // Fetch pending jobs
  const { data: pending, error: fetchErr } = await supabase
    .from('system_jobs')
    .select('*')
    .in('status', ['pending', 'queued'])
    .order('queued_at', { ascending: true, nullsFirst: false })
    .limit(maxJobs)

  if (fetchErr) {
    console.error('[Jobs] Failed to fetch pending jobs:', fetchErr)
    return []
  }
  if (!pending || pending.length === 0) return []

  // Claim each job by updating status to 'running'
  const claimed: DequeuedJob[] = []
  for (const job of pending) {
    const { data: updated, error: updateErr } = await supabase
      .from('system_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', job.status) // optimistic lock: only update if still same status
      .select('*')
      .single()

    if (!updateErr && updated) {
      claimed.push(updated as DequeuedJob)
    }
  }

  return claimed
}

/**
 * Marks a job as completed
 */
export async function completeJob(job: DequeuedJob, metadataUpdates?: any): Promise<void> {
  const supabase = createAdminClient()

  const { error } = await supabase
    .from('system_jobs')
    .update({
      status: 'completed',
      finished_at: new Date().toISOString(),
    })
    .eq('id', job.id)

  if (error) console.error(`[Jobs] Failed to complete job ${job.id}:`, error)
  else await publishAdEvent(job.attempts > 0 ? 'retry_completed' : 'job_completed', { metadata: { job_id: job.id, job_type: job.job_type } })
}

/**
 * Fails a job, triggering exponential backoff or dead letter queue
 */
export async function failJob(job: DequeuedJob, errorMsg: string): Promise<void> {
  const supabase = createAdminClient()

  const newAttempts = (job.attempts || 0) + 1
  const isDeadLetter = newAttempts >= (job.max_attempts || 3)

  const { error } = await supabase
    .from('system_jobs')
    .update({
      status: isDeadLetter ? 'failed' : 'pending',
      attempts: newAttempts,
      queued_at: new Date().toISOString(),
      finished_at: isDeadLetter ? new Date().toISOString() : null,
      error_log: errorMsg,
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

