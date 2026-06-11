const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const currentYear = new Date().getFullYear();
  const { data: tasksRes } = await supabase
    .from('tasks')
    .select('id, title, task_date, status, client:clients(name), service:services(name)')
    .in('status', ['done', 'delivered', 'invoiced', 'paid'])
    .gte('task_date', `${currentYear - 1}-01-01`)
    .order('task_date', { ascending: false });

  const forUs = tasksRes.find(t => t.id === 'dfc80470-7e34-44eb-9a2f-156df66f8ab2');
  console.log("Is 'For Us' in tasksRes?", forUs ? "Yes" : "No");
  if (!forUs) {
    const { data: t } = await supabase.from('tasks').select('id, title, task_date, status').eq('id', 'dfc80470-7e34-44eb-9a2f-156df66f8ab2');
    console.log("Database status:", t);
  }
}
run();
