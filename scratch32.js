const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: emps } = await supabase.from('employees').select('id, cqid').in('cqid', ['CQID001', 'CQID002']);
  
  const empIds = emps.map(e => e.id);
  const { data: p } = await supabase.from('payroll')
    .select('id, employee:employees(cqid), month, year, net_salary')
    .in('employee_id', empIds)
    .eq('month', 10)
    .eq('year', 2025);
    
  console.log("October 2025 Payrolls:", JSON.stringify(p, null, 2));
}
run();
