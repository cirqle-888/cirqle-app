const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: p } = await supabase.from('payroll')
    .select('employee:employees(cqid), base_salary, commission_earned, net_salary, status')
    .eq('year', 2026)
    .eq('month', 5);
  console.log("Payroll records for May 2026:", JSON.stringify(p, null, 2));
}
run();
