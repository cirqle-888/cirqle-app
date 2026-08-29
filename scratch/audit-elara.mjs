/** READ ONLY — inspect Elara Luxe Perfume agreement items + their tasks. */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local', quiet: true })
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const { data: client } = await db.from('clients').select('id,name,code').ilike('name', '%Elara%').single()
console.log('CLIENT', client)

const { data: ags } = await db.from('client_agreements')
  .select('id, agreement_number, status').eq('client_id', client.id)
console.log('AGREEMENTS', JSON.stringify(ags, null, 1))

const { data: items } = await db.from('client_agreement_items')
  .select('*').in('agreement_id', ags.map(a => a.id)).order('effective_from')

for (const it of items) {
  console.log('\n--- ITEM', it.id.slice(0,8), '|', it.invoice_label ?? it.description ?? '(no label)')
  console.log('   effective', it.effective_from, '→', it.effective_to ?? 'current')
  const keep = ['currency','unit_price','extra_unit_price','quantity','included_quantity',
    'creative_allocation','management_allocation','work_unit_currency','work_unit_value',
    'work_commission_pct','service_id','billing_cycle','carry_forward']
  for (const k of keep) if (it[k] !== undefined) console.log('  ', k.padEnd(24), it[k])
}
