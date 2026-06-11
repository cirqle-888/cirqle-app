const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: categories } = await supabase.from('cashbook_categories').select('id').ilike('name', '%Salary%').eq('type', 'outflow').limit(1);
  const salaryId = categories[0].id;

  const { data: cb } = await supabase.from('cashbook_entries')
    .select('id, amount, entry_date, employee_id, notes')
    .eq('category_id', salaryId)
    .not('notes', 'is', null);
    
  console.log("Entries with notes:", cb);
}
run();
