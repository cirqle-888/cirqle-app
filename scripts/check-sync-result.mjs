import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

const PROJECT_ID = 'a8e10f01-f1c9-4b04-b0b3-3e5e4087e5ab'

// 1. Check sync logs
const { data: logs } = await supabase
  .from('ad_sync_logs')
  .select('*')
  .eq('project_id', PROJECT_ID)
  .order('started_at', { ascending: false })
  .limit(5)
console.log('Sync logs for Hiring Poster:')
console.table(logs?.map(l => ({ status: l.status, records: l.records_imported, started: l.started_at?.slice(11,19), error: l.error_message?.slice(0,60) })) ?? 'none')

// 2. Check job statuses
const { data: jobs } = await supabase
  .from('system_jobs')
  .select('id, status, error_log, updated_at')
  .contains('payload', { project_id: PROJECT_ID })
  .order('updated_at', { ascending: false })
  .limit(5)
console.log('\nJobs for Hiring Poster:')
console.table(jobs?.map(j => ({ id: j.id?.slice(0,8), status: j.status, error: j.error_log?.slice(0,80), updated: j.updated_at?.slice(11,19) })))

// 3. Check ad_project mapping
const { data: proj } = await supabase
  .from('ad_projects')
  .select('id, ad_account_id, external_campaign_id, provider_metadata, sync_status')
  .eq('id', PROJECT_ID)
  .single()
console.log('\nHiring Poster project:')
console.log(JSON.stringify(proj, null, 2))

// 4. Check connection status
if (proj?.ad_account_id) {
  const { data: acct } = await supabase
    .from('ad_accounts')
    .select('id, account_id, provider, connection_id')
    .eq('id', proj.ad_account_id)
    .single()
  console.log('\nAd account:', JSON.stringify(acct, null, 2))

  if (acct?.connection_id) {
    const { data: conn } = await supabase
      .from('provider_connections')
      .select('id, status, provider, expires_at')
      .eq('id', acct.connection_id)
      .single()
    console.log('\nConnection:', JSON.stringify(conn, null, 2))
  }
}
