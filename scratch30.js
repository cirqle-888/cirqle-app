const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: categories } = await supabase.from('cashbook_categories').select('id').ilike('name', '%Salary%').eq('type', 'outflow').limit(1);
  const salaryId = categories[0].id;

  const { data: cb } = await supabase.from('cashbook_entries')
    .select('id, amount, entry_date, employee_id, description')
    .eq('category_id', salaryId)
    .is('notes', null)
    .limit(5);
    
  console.log("Sample original entries:");
  console.log(JSON.stringify(cb, null, 2));
}
run();
