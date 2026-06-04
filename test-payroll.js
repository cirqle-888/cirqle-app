const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

async function run() {
  const { count: payrollCount } = await supabase.from('payroll').select('*', { count: 'exact', head: true });
  console.log('Payroll records count:', payrollCount);
  
  const { data: payrollRows } = await supabase.from('payroll').select('id, employee_id, month, year, net_salary');
  console.log('Payroll rows sample:', payrollRows);

  const { count: scoresCount } = await supabase.from('contribution_scores').select('*', { count: 'exact', head: true });
  console.log('Contribution scores count:', scoresCount);
}

run();
