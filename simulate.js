import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function run() {
  const clientName = 'Elara Luxe Perfume'
  const { data: clients } = await supabase.from('clients').select('*').ilike('name', `%${clientName}%`)
  const client = clients[0]

  // Get services
  const { data: services } = await supabase.from('services').select('id, name')
  const posterSvc = services.find(s => s.name === 'Social Media Poster')
  
  console.log('Inserting simulated task for Poster...')
  const { data: task, error } = await supabase.from('tasks').insert({
    title: 'Simulated Poster #1',
    client_id: client.id,
    service_id: posterSvc.id,
    task_date: '2026-07-29',
    status: 'done',
    billing_amount: 20,
    currency: 'AED',
    quantity: 1
  }).select('*').single()
  
  if (error) { console.error('Insert Error:', error); return }
  
  console.log('Inserted Task:', task.title)
  console.log('retainer_item_id:', task.retainer_item_id)
  
  // Check invoice lines
  console.log('Checking invoice lines for task...')
  const { data: invItems } = await supabase.from('invoice_items').select('*').eq('task_id', task.id)
  console.log('Invoice items for covered task:', invItems.length)

  console.log('Updating bill_as_extra = true...')
  const { data: updatedTask } = await supabase.from('tasks').update({ bill_as_extra: true }).eq('id', task.id).select('*').single()
  console.log('bill_as_extra:', updatedTask.bill_as_extra)

  const { data: invItemsAfter } = await supabase.from('invoice_items').select('*').eq('task_id', task.id)
  console.log('Invoice items after bill_as_extra=true:', invItemsAfter.length)
  
  // Cleanup
  await supabase.from('tasks').delete().eq('id', task.id)
  console.log('Simulated task cleaned up.')
}
run()
