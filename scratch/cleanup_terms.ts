import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const env = fs.readFileSync('.env.local', 'utf8')
const supabaseUrl = env.match(/NEXT_PUBLIC_SUPABASE_URL=(.*)/)?.[1]
const supabaseKey = env.match(/SUPABASE_SERVICE_ROLE_KEY=(.*)/)?.[1]

const supabase = createClient(supabaseUrl!, supabaseKey!)

async function run() {
  const latestRetainer = 'f720a02a-ce07-4610-9034-94f8661c464f'
  const oldRetainers = ['40000fc3-6ce5-422b-afc4-8aa3d3db3e76', 'aba7a813-f14f-4626-aa24-34910da12e7c']

  const latestOneTime = '9091e846-60b6-477f-a477-78fccdbd2319'
  const oldOneTimes = ['cb43ddd2-602b-4b64-9b89-c06706acaeb3', '4080ba65-207a-4b37-b3a8-28cde8050688', 'bf712dce-47ae-4c10-9a95-2fb3c9daf05b']

  // 1. Re-point tasks for Retainers
  for (const old of oldRetainers) {
    await supabase.from('tasks').update({ retainer_item_id: latestRetainer }).eq('retainer_item_id', old)
    await supabase.from('client_agreement_tasks').update({ item_id: latestRetainer }).eq('item_id', old)
  }

  // 2. Re-point tasks for One-Times
  for (const old of oldOneTimes) {
    await supabase.from('tasks').update({ retainer_item_id: latestOneTime }).eq('retainer_item_id', old)
    await supabase.from('client_agreement_tasks').update({ item_id: latestOneTime }).eq('item_id', old)
  }

  // 3. Update effective_from of the latest items to '2026-07-20'
  await supabase.from('client_agreement_items').update({ effective_from: '2026-07-20' }).eq('id', latestRetainer)
  await supabase.from('client_agreement_items').update({ effective_from: '2026-07-20' }).eq('id', latestOneTime)

  // 4. Delete old items
  await supabase.from('client_agreement_items').delete().in('id', [...oldRetainers, ...oldOneTimes])

  console.log("Cleanup done!")
}

run().catch(console.error)
