const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: e, error } = await supabase.from('cashbook_entries').select(`
    id, amount_inr, 
    payroll_allocations:cashbook_payroll_allocations(
      id, allocated_amount, payroll_id
    )
  `).eq('notes', '[System]: Historical CSV Import').limit(2);
  console.log("Query result:", JSON.stringify(e, null, 2));
}
run();
