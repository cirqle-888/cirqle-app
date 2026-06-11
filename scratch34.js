const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: emps } = await supabase.from('employees').select('id, cqid').in('cqid', ['CQID001', 'CQID002']);
  const empIds = emps.map(e => e.id);

  const { data: p } = await supabase.from('payroll')
    .select('id, employee:employees(cqid), month, year, net_salary, cashbook_payroll_allocations(allocated_amount)')
    .in('employee_id', empIds)
    .eq('month', 9)
    .eq('year', 2025);
    
  console.log("September 2025 Payrolls:");
  console.log(JSON.stringify(p, null, 2));
}
run();
