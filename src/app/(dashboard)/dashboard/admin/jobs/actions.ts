'use server'

import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/enforce'
import { revalidatePath } from 'next/cache'

export async function fetchJobsSummary() {
  const auth = await requireAdmin()
  if (!auth.ok) return { pending: 0, running: 0, failed: 0, completed: 0, dead_letter: 0 }
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('system_jobs')
    .select('status, id')

  if (error || !data) return { pending: 0, running: 0, failed: 0, completed: 0, dead_letter: 0 }

  const summary = { pending: 0, running: 0, failed: 0, completed: 0, dead_letter: 0 }
  data.forEach((j: any) => {
    if (j.status === 'pending' || j.status === 'waiting' || j.status === 'queued') summary.pending++
    else if (j.status === 'running') summary.running++
    else if (j.status === 'failed' || j.status === 'retrying') summary.failed++
    else if (j.status === 'completed') summary.completed++
    else if (j.status === 'dead_letter') summary.dead_letter++
  })

  return summary
}

export async function fetchRecentJobs() {
  const auth = await requireAdmin()
  if (!auth.ok) return []
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('system_jobs')
    .select('*')
    .order('queued_at', { ascending: false })
    .limit(50)

  if (error) throw error
  return data
}

export async function retryJob(jobId: string) {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }
  const admin = createAdminClient()
  const { error } = await admin
    .from('system_jobs')
    .update({ 
      status: 'pending', 
      attempts: 0, 
      error_log: null, 
      locked_at: null, 
      locked_by: null,
      queued_at: new Date().toISOString()
    })
    .eq('id', jobId)
    
  if (error) throw error
  revalidatePath('/dashboard/admin/jobs')
  return { ok: true }
}

export async function cancelJob(jobId: string) {
  const auth = await requireAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }
  const admin = createAdminClient()
  const { error } = await admin
    .from('system_jobs')
    .update({ 
      status: 'cancelled', 
      locked_at: null, 
      locked_by: null
    })
    .eq('id', jobId)
    
  if (error) throw error
  revalidatePath('/dashboard/admin/jobs')
  return { ok: true }
}
