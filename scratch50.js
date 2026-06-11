const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: tasks, error } = await supabase.from('tasks')
    .select('id, title, task_date, status')
    .in('title', ['Happy Shopping Days', 'Eid Summer Deals', 'Happy Shopping Days ', 'Eid Summer Deals ']); // Added space padding just in case

  if (error) console.error("Error:", error);
  console.log("Tasks:", tasks);
}
run();
