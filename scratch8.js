const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data: alloc } = await supabase.from('cashbook_payroll_allocations').select('*').limit(1);
  console.log('alloc:', alloc);
}
run();
