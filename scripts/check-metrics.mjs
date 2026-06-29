import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

const PROJECT_ID = 'a8e10f01-f1c9-4b04-b0b3-3e5e4087e5ab'

const { data, error } = await supabase
  .from('ad_daily_metrics')
  .select('metric_date, spend, impressions, clicks, reach, leads, sync_state, source')
  .eq('project_id', PROJECT_ID)
  .order('metric_date', { ascending: false })

if (error) console.error('Error:', error)
else {
  console.log(`ad_daily_metrics for Hiring Poster: ${data?.length ?? 0} rows`)
  console.table(data?.map(r => ({
    date: r.metric_date,
    spend: r.spend,
    impressions: r.impressions,
    clicks: r.clicks,
    leads: r.leads,
    state: r.sync_state,
    source: r.source
  })))
}
