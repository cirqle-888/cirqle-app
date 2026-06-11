const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: c } = await supabase.from('cashbook_entries').select('*').eq('type', 'outflow');
  console.log("Total cashbook entries inserted:", c?.length);
  const { data: a } = await supabase.from('cashbook_payroll_allocations').select('*');
  console.log("Total allocations inserted:", a?.length);
}
run();
