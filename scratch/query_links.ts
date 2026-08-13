import { createAdminClient } from '../src/lib/supabase/admin'

async function run() {
  const supabase = await createAdminClient()
  const { data: links } = await supabase
    .from('client_agreement_tasks')
    .select('*')
    .eq('task_id', '085249f4-d063-4d7b-a0be-57cf0577e2c1')
  console.log(JSON.stringify(links, null, 2))
}

run()
