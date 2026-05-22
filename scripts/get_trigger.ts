import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
import * as path from 'path'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const supabase = createClient(supabaseUrl!, supabaseKey!)

async function main() {
  const { data, error } = await supabase.rpc('get_function_def', { function_name: 'auto_attach_task_to_invoice' })
  if (error) {
    // try querying directly if rpc fails
    const res = await supabase.from('invoices').select('id').limit(1)
    console.log("fallback", res)
  }
  console.log(data)
}

main().catch(console.error)
