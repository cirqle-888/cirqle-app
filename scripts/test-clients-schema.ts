import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })
async function run() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data, error } = await supabase.from('clients').select('*').limit(1)
  console.log('Error:', error)
  console.log('Client Keys:', data ? Object.keys(data[0] || {}) : [])
}
run()
