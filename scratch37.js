const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: t } = await supabase.from('tasks').select('task_date').eq('task_number', 1649).limit(1);
  console.log("Task Date:", t[0]?.task_date);
}
run();
