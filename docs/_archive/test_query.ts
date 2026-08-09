import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function test() {
  const { data, error } = await supabase
    .from('cashbook_entries')
    .select(`
      id,
      direct_invoice:invoices!cashbook_entries_invoice_id_fkey(invoice_number, client:clients(name))
    `)
    .limit(1)
  console.log('FKEY Result:', error ? error.message : data)
  
  const { data: d2, error: e2 } = await supabase
    .from('cashbook_entries')
    .select(`
      id,
      direct_invoice:invoices!invoice_id(invoice_number, client:clients(name))
    `)
    .limit(1)
  console.log('invoice_id Result:', e2 ? e2.message : d2)
}

test()
