import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

async function runAudit() {
  console.log("=== Step 1 - Verify Agreement ===")
  const { data: client, error: errClient } = await supabase
    .from('clients')
    .select('*')
    .ilike('name', '%Elara Luxe%')
    .single()
  
  if (errClient || !client) {
    console.error("Client not found:", errClient)
    return
  }
  console.log("Client:", client.name, "ID:", client.id)

  const { data: agreements, error: errAgr } = await supabase
    .from('client_agreements')
    .select(`
      *,
      items:client_agreement_items(
        *,
        services:agreement_item_services(service_id)
      )
    `)
    .eq('client_id', client.id)
    
  if (errAgr) {
    console.error("Error fetching agreements:", errAgr)
  } else {
    console.log("Agreements:\n", JSON.stringify(agreements, null, 2))
  }

  console.log("\n=== Step 2 - Verify Existing Task ===")
  const { data: tasks, error: errTask } = await supabase
    .from('tasks')
    .select(`
      *,
      service:services(name)
    `)
    .eq('client_id', client.id)
    .ilike('title', '%Logo Reveal Poster%')

  console.log("Tasks:", JSON.stringify(tasks, null, 2))

  console.log("\n=== Checking Invoice Items for the Task ===")
  if (tasks && tasks.length > 0) {
    const { data: invItems, error: errInv } = await supabase
      .from('invoice_items')
      .select('*')
      .eq('task_id', tasks[0].id)
    console.log("Invoice Items for Task:", JSON.stringify(invItems, null, 2))
    
    // Step 3 - Agreement Progress
    console.log("\n=== Step 3 - Agreement Progress ===")
    // Let's check agreement_items to see delivered count
    if (agreements && agreements.length > 0) {
       for (const item of agreements[0].items) {
           if (item.id === tasks[0].retainer_item_id) {
               console.log(`Matched Item: ${item.name} | Qty: ${item.quantity} | Delivered: (Wait, delivered is computed in JS logic, let's fetch it)`)
           }
       }
    }
  }

}

runAudit()
