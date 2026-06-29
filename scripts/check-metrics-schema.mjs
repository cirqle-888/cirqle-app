import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
const get = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim()

const supabase = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

// Try a minimal insert to see what error we get
const PROJECT_ID = 'a8e10f01-f1c9-4b04-b0b3-3e5e4087e5ab'

const { error } = await supabase
  .from('ad_daily_metrics')
  .upsert([{
    project_id: PROJECT_ID,
    metric_date: '2026-06-29',
    spend: 100,
    impressions: 1000,
    clicks: 10,
    reach: 500,
    leads: 2,
    revenue: 0,
    source: 'meta API',
    sync_state: 'imported',
    version: 1,
    base_currency: 'INR',
    ad_currency: 'INR',
    billing_currency: 'INR',
    exchange_rate_ad_to_base: 1.0,
    exchange_rate_ad_to_billing: 1.0,
  }], { onConflict: 'project_id,metric_date' })

if (error) {
  console.error('Upsert error:', JSON.stringify(error, null, 2))
} else {
  console.log('Upsert succeeded! Checking row...')
  const { data } = await supabase
    .from('ad_daily_metrics')
    .select('*')
    .eq('project_id', PROJECT_ID)
    .eq('metric_date', '2026-06-29')
    .single()
  console.log('Row:', JSON.stringify(data, null, 2))
}
