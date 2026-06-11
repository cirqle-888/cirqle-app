const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: e, error } = await supabase.from('cashbook_entries').select(`
    id, amount_inr, category_id,
    category:cashbook_categories(id, name, type),
    payroll_allocations:cashbook_payroll_allocations(
      id, allocated_amount, deleted_at
    )
  `).eq('notes', '[System]: Historical CSV Import').limit(1);

  console.log("Entry:", JSON.stringify(e[0], null, 2));

  const entry = e[0];
  const isSal = entry.category.name.toLowerCase().includes('salary');
  
  const totalAlloc = isSal 
    ? (entry.payroll_allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0)
    : 0;
    
  console.log("isSal:", isSal);
  console.log("totalAlloc:", totalAlloc);
  console.log("amount_inr:", entry.amount_inr);
  
  const unallocated = (entry.amount_inr || 0) - totalAlloc;
  console.log("unallocated:", unallocated);
  
  const allocStatus = (!isSal) ? null : unallocated <= 0.01 && unallocated >= -0.01 ? 'fully' : unallocated > 0.01 && totalAlloc > 0 ? 'partial' : unallocated < -0.01 ? 'over' : 'none';
  console.log("allocStatus:", allocStatus);
}
run();
