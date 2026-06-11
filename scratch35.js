const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase.from('contributions')
    .upsert([{ task_id: null, employee_id: '1bcc1f97-f490-4cb4-97b9-27baacf2efd1', parameter_id: 'test', value: 1 }], { onConflict: 'task_id,employee_id,parameter_id' });
  console.log("Error:", error?.message);
}
run();
