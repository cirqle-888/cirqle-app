import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Check recent jobs
const { data: jobs, error } = await supabase
  .from('system_jobs')
  .select('id, job_type, status, payload, created_at, error_log')
  .order('created_at', { ascending: false })
  .limit(10)

if (error) { console.error('Error:', error); process.exit(1) }
console.log('Recent jobs in system_jobs:')
console.table(jobs?.map(j => ({ id: j.id?.slice(0,8), type: j.job_type, status: j.status, project: j.payload?.project_id?.slice(0,8), created: j.created_at?.slice(11,19), error: j.error_log?.slice(0,50) })))

// Also manually enqueue a sync job for Hiring Poster
const PROJECT_ID = 'a8e10f01-f1c9-4b04-b0b3-3e5e4087e5ab'
console.log('\nEnqueueing sync job for Hiring Poster...')
const { data: job, error: e2 } = await supabase
  .from('system_jobs')
  .insert({ job_type: 'advertising_sync_project', priority: 'high', status: 'pending', payload: { project_id: PROJECT_ID }, max_attempts: 3 })
  .select('id')
  .single()

if (e2) console.error('Enqueue error:', e2)
else console.log('Job enqueued:', job.id)
