const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: t } = await supabase.from('tasks')
    .select('id, title, task_date, client:clients(name)')
    .eq('task_date', '2026-05-02');
  console.log("Tasks on 2026-05-02:", JSON.stringify(t, null, 2));
}
run();
