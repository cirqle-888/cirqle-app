const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: a, error } = await supabase.from('cashbook_payroll_allocations').select('*, cashbook_entries(amount)').limit(5);
  console.log("Sample allocations:", a);
}
run();
