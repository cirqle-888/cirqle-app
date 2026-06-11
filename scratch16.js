const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: c } = await supabase.from('cashbook_entries').select('id').eq('notes', '[System]: Historical CSV Import');
  console.log("Cashbook entries from script:", c?.length);
  
  // also check how many allocations
  const { data: a } = await supabase.from('cashbook_payroll_allocations').select('id');
  console.log("Allocations:", a?.length);
}
run();
