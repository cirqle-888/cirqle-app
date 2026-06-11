const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: e } = await supabase.from('cashbook_entries').select(`
    id, amount_inr, category_id,
    payroll_allocations:cashbook_payroll_allocations(
      id,
      payroll_id,
      allocated_amount,
      deleted_at,
      payroll:payroll(employee_id, net_salary, status, employee:employees(cqid, name))
    )
  `).eq('notes', '[System]: Historical CSV Import').eq('entry_date', '2024-12-23').limit(1);

  const { data: categoriesRes } = await supabase.from('cashbook_categories').select('*').order('type').order('name');
  
  const categories = categoriesRes || [];
  const entry = e[0];

  const invoiceCategoryId = categories.find(c => c.name.toLowerCase().includes('invoice'))?.id;
  const salaryCategoryId = categories.find(c => c.name.toLowerCase().includes('salary'))?.id;

  const isInvoice = entry.category_id === invoiceCategoryId;
  const isSalary = entry.category_id === salaryCategoryId;

  let totalAlloc = 0;
  if (isInvoice) totalAlloc = entry.allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0;
  if (isSalary) totalAlloc = entry.payroll_allocations?.filter(a => !a.deleted_at).reduce((s, a) => s + Number(a.allocated_amount), 0) || 0;

  const unallocated = (entry.amount_inr || 0) - totalAlloc;
  const allocStatus = (!isInvoice && !isSalary) ? null : unallocated <= 0.01 && unallocated >= -0.01 ? 'fully' : unallocated > 0.01 && totalAlloc > 0 ? 'partial' : unallocated < -0.01 ? 'over' : 'none';

  console.log("isSalary:", isSalary);
  console.log("totalAlloc:", totalAlloc);
  console.log("unallocated:", unallocated);
  console.log("allocStatus:", allocStatus);
}
run();
