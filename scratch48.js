const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: t } = await supabase.from('tasks')
    .select('title, task_date')
    .in('title', ['Saturday Specials', 'Killer Deal Storm : Grocery Updated', 'Vegetables Updating: Fresh Market', 'Vegetable Updating: Fresh Market']);
  console.log("Tasks:", t);
}
run();
