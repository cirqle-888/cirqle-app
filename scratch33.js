const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function getCashbookTargetPeriod(dateStr) {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (day >= 20 && day <= 31) return { month, year };
  if (day >= 1 && day <= 15) {
    let m = month - 1; let y = year;
    if (m === 0) { m = 12; y = year - 1; }
    return { month: m, year: y };
  }
  return { month, year };
}

async function run() {
  const { data: categories } = await supabase.from('cashbook_categories').select('id').ilike('name', '%Salary%').eq('type', 'outflow').limit(1);
  const salaryId = categories[0].id;

  const { data: cb } = await supabase.from('cashbook_entries')
    .select('id, amount, entry_date, employee_id, description, payroll_allocations:cashbook_payroll_allocations(allocated_amount)')
    .eq('category_id', salaryId)
    .is('notes', null);

  const octEntries = cb.filter(e => {
    const p = getCashbookTargetPeriod(e.entry_date);
    return p.month === 10 && p.year === 2025;
  });
  
  console.log("October 2025 Target Entries:");
  console.log(JSON.stringify(octEntries, null, 2));
}
run();
