import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const { data } = await supabase.from('invoices').select('*').eq('invoice_number', 'INV-2605-033')
  console.log('Invoice:', data)
  
  const { data: allocations } = await supabase.from('cashbook_invoice_allocations').select('*').eq('invoice_id', data?.[0]?.id)
  console.log('Allocations:', allocations)
  
  const { data: payments } = await supabase.from('payments').select('*').eq('invoice_id', data?.[0]?.id)
  console.log('Payments:', payments)
}
main()
