const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: tables } = await supabase.rpc('get_tables'); // Or just fetch all from information_schema
  const { data: q } = await supabase.from('payroll').select('*').limit(1);
  console.log('payroll:', q[0]);
  const { data: c } = await supabase.from('cashbook_entries').select('*').limit(1);
  console.log('cashbook_entries:', c[0]);
  
  // Checking for allocations table
  const { data: alloc1 } = await supabase.from('allocations').select('*').limit(1);
  console.log('allocations:', alloc1 ? 'exists' : 'not found');
  const { data: alloc2 } = await supabase.from('payroll_allocations').select('*').limit(1);
  console.log('payroll_allocations:', alloc2 ? 'exists' : 'not found');
  const { data: alloc3 } = await supabase.from('cashbook_allocations').select('*').limit(1);
  console.log('cashbook_allocations:', alloc3 ? 'exists' : 'not found');
}
run();
