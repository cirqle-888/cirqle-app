import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function run() {
  console.log('--- Step 1: Client ---')
  const { data: clients, error: err1 } = await supabase.from('clients').select('*').ilike('name', '%Elara Luxe Perfume%')
  if (err1) { console.error(err1); return }
  const client = clients[0]
  if (!client) { console.log('Client not found'); return }
  console.log('Client:', client.id, client.name)

  console.log('--- Step 1: Agreement ---')
  const { data: agreements, error: err2 } = await supabase.from('client_agreements').select('*').eq('client_id', client.id)
  if (err2) { console.error(err2); return }
  const agreement = agreements[0]
  console.log('Agreement:', agreement?.id, agreement?.status)

  console.log('--- Step 1: Items ---')
  if (agreement) {
    const { data: items, error: err3 } = await supabase.from('client_agreement_items').select('*').eq('agreement_id', agreement.id)
    if (err3) { console.error(err3); return }
    console.log('Items:', JSON.stringify(items, null, 2))

    console.log('--- Step 1: Item Services ---')
    if (items.length > 0) {
      const { data: itemServices, error: err4 } = await supabase.from('agreement_item_services').select('*, service:services(name)').in('agreement_item_id', items.map(i => i.id))
      if (err4) { console.error(err4); return }
      console.log('Item Services:', JSON.stringify(itemServices, null, 2))
    }
  }

  console.log('--- Step 2: Task ---')
  const { data: tasks, error: err5 } = await supabase.from('tasks').select('*, service:services(name)').eq('client_id', client.id).ilike('title', '%Logo Reveal Poster%')
  if (err5) { console.error(err5); return }
  console.log('Tasks:', JSON.stringify(tasks, null, 2))
}

run()
