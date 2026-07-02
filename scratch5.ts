import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY! || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)

async function run() {
  const monthStart = '2026-06-01'
  const monthEnd = '2026-06-30'
  const client_id = '57ecb2bf-2565-4537-b08c-53b01fcc3040' // Mezza

  const { data: expEntries } = await supabase
    .from('cashbook_entries')
    .select('id, amount_inr, description, currency, amount')
    .eq('client_id', client_id)
    .eq('type', 'outflow')
    .is('deleted_at', null)
    .gte('entry_date', monthStart)
    .lte('entry_date', monthEnd)
    
  console.log("Found expEntries:", expEntries?.length)

  if (expEntries?.length) {
    const { data: alreadyBilled } = await supabase
      .from('invoice_expense_items')
      .select('cashbook_entry_id, invoice:invoices(status)')
      .in('cashbook_entry_id', expEntries.map((e: any) => e.id))
      
    console.log("alreadyBilled:", JSON.stringify(alreadyBilled, null, 2))

    // Wait, are there MULTIPLE invoice_expense_items for the same cashbook entry?
    // Let's check!
    const billedIds = new Set(
      (alreadyBilled || []).filter((b: any) => b.invoice?.status !== 'cancelled').map((b: any) => b.cashbook_entry_id)
    )
    console.log("billedIds:", Array.from(billedIds))

    const toAddExp = expEntries.filter((e: any) => !billedIds.has(e.id))
    console.log("toAddExp:", toAddExp.length)
  }
}
run()
