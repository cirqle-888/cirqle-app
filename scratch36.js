const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: t } = await supabase.from('tasks').select('id, task_number, billing_amount_inr, status').eq('task_number', 1649).limit(1);
  if (!t || t.length === 0) return console.log("Task not found");
  
  console.log("Task:", t[0]);

  const { data: cs } = await supabase.from('contribution_scores').select('*').eq('task_id', t[0].id);
  console.log("Scores:", cs);
  
  const { data: c } = await supabase.from('contributions').select('*').eq('task_id', t[0].id);
  console.log("Contributions:", c);
}
run();
