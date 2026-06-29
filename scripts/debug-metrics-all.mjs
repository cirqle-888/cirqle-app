import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// All rows in ad_daily_metrics
const { data, error } = await supabase
  .from('ad_daily_metrics')
  .select('project_id, metric_date, spend, impressions, clicks, sync_state, source, created_at')
  .order('created_at', { ascending: false })
  .limit(20)

console.log(`Total ad_daily_metrics rows (last 20): ${data?.length ?? 0}`)
if (error) console.error('Error:', error)
else console.table(data?.map(r => ({
  project: r.project_id?.slice(0, 8),
  date: r.metric_date,
  spend: r.spend,
  impressions: r.impressions,
  state: r.sync_state,
  source: r.source,
  created: r.created_at?.slice(11, 19)
})))

// Latest sync logs
const { data: logs } = await supabase
  .from('ad_sync_logs')
  .select('project_id, status, records_imported, started_at, error_message')
  .order('started_at', { ascending: false })
  .limit(5)

console.log('\nLatest sync logs:')
console.table(logs?.map(l => ({
  project: l.project_id?.slice(0, 8),
  status: l.status,
  records: l.records_imported,
  started: l.started_at?.slice(11, 19),
  error: l.error_message
})))
