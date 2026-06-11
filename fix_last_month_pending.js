const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log("Fixing 'Last Month Pending' for CQID001 and CQID002...");

  // Get the two entries
  const { data: entries } = await supabase.from('cashbook_entries')
    .select('id, amount, employee_id, description')
    .ilike('description', '%Last Month Pending%')
    .eq('entry_date', '2025-11-05');

  // Get September 2025 payrolls
  const { data: payrolls } = await supabase.from('payroll')
    .select('id, employee_id, net_salary, cashbook_payroll_allocations(allocated_amount)')
    .eq('month', 9)
    .eq('year', 2025);

  for (const entry of entries) {
    const p = payrolls.find(p => p.employee_id === entry.employee_id);
    if (!p) continue;

    const currentlyAllocated = p.cashbook_payroll_allocations.reduce((sum, a) => sum + a.allocated_amount, 0);
    const remaining = p.net_salary - currentlyAllocated;

    let allocAmount = 0;
    if (remaining > 0.01) {
      allocAmount = Math.min(entry.amount, remaining);
    }

    if (allocAmount > 0.01) {
      const { error: insErr } = await supabase.from('cashbook_payroll_allocations').insert({
        cashbook_entry_id: entry.id,
        payroll_id: p.id,
        allocated_amount: allocAmount
      });
      if (insErr) {
        console.error("Error inserting allocation:", insErr);
        continue;
      }
      console.log(`Allocated ${allocAmount} to payslip ${p.id}`);

      // Check if paid
      const newTotal = currentlyAllocated + allocAmount;
      if (newTotal >= p.net_salary - 0.05) {
        await supabase.from('payroll').update({ status: 'paid', paid_date: new Date().toISOString() }).eq('id', p.id);
        console.log(`Marked payslip ${p.id} as paid.`);
      }
    }
  }
  
  console.log("Fixed!");
}
run();
