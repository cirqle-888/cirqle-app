import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function run() {
  const { data: agrs } = await supabase.from('client_agreements').select('client_id').limit(1)
  const clientId = agrs?.[0]?.client_id
  if (!clientId) return console.log('no target client')
  
  const { data: allAgrs } = await supabase
    .from('client_agreements')
    .select('id, agreement_number')
    .eq('client_id', clientId)
    .in('status', ['active', 'paused'])
    .is('deleted_at', null)

  console.log(allAgrs)
}
run()
