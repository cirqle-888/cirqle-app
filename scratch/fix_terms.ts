import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const supabaseUrl = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)?.[1]
const supabaseKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1]

const supabase = createClient(supabaseUrl!, supabaseKey!)

async function run() {
  const agrId = '20f443d6-3e85-487b-9080-86101b58f4d3' // from screenshot URL
  
  const { data: items } = await supabase
    .from('client_agreement_items')
    .select('id, service_id, effective_from, effective_to, commitment_type, invoice_label')
    .eq('agreement_id', agrId)
    .order('effective_from', { ascending: true })
    
  console.log(items)
}

run()
