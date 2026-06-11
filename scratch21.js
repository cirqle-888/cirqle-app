const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: c } = await supabase.from('cashbook_entries')
    .select('id, amount, amount_inr, entry_date, payroll_allocations:cashbook_payroll_allocations(id, allocated_amount)')
    .eq('entry_date', '2024-12-23')
    .eq('notes', '[System]: Historical CSV Import');
    
  console.log("Entries:", JSON.stringify(c, null, 2));
}
run();
