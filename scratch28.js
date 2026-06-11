const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: e } = await supabase.from('cashbook_entries')
    .select('id, amount, bank_account:bank_accounts(name), notes, payroll_allocations:cashbook_payroll_allocations(id, allocated_amount, payroll_id)')
    .eq('entry_date', '2026-05-06')
    .is('notes', null);
    
  console.log("Jupiter Money Entries on 2026-05-06:");
  console.log(JSON.stringify(e, null, 2));
}
run();
