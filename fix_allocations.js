const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAll(table, select = '*', query = q => q) {
  let allData = [];
  let from = 0;
  const size = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + size - 1);
    q = query(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    allData = allData.concat(data);
    if (data.length < size) break;
    from += size;
  }
  return allData;
}

function getCashbookTargetPeriod(dateStr) {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  
  if (day >= 20 && day <= 31) return { month, year };
  if (day >= 1 && day <= 15) {
    let m = month - 1;
    let y = year;
    if (m === 0) { m = 12; y = year - 1; }
    return { month: m, year: y };
  }
  return { month, year };
}

async function run() {
  console.log("Starting original entries allocation rebuild...");

  // 1. Setup
  const { data: categories } = await supabase.from('cashbook_categories').select('id').ilike('name', '%Salary%').eq('type', 'outflow').limit(1);
  const salaryId = categories[0].id;

  // 2. Fetch Original Salary Cashbook Entries
  const cashbookEntries = await fetchAll('cashbook_entries', 'id, amount, entry_date, employee_id', q => q.eq('category_id', salaryId).is('notes', null));
  console.log(`Found ${cashbookEntries.length} original salary entries.`);

  // 3. Clear existing allocations for these specific entries
  const cbIds = cashbookEntries.map(cb => cb.id);
  if (cbIds.length > 0) {
    const { error: delErr } = await supabase.from('cashbook_payroll_allocations').delete().in('cashbook_entry_id', cbIds);
    if (delErr) throw delErr;
    console.log("Cleared old messy allocations.");
  }

  // 4. Group cashbook entries by Target Period & Employee
  const paymentMap = {}; // key: "empId-year-month"
  cashbookEntries.forEach(cb => {
    if (!cb.employee_id) return;
    const { month, year } = getCashbookTargetPeriod(cb.entry_date);
    const key = `${cb.employee_id}-${year}-${month}`;
    if (!paymentMap[key]) paymentMap[key] = { entries: [], totalAmount: 0 };
    paymentMap[key].entries.push(cb);
    paymentMap[key].totalAmount += cb.amount;
  });

  // 5. Fetch all payrolls from Nov 2024 onwards
  const payrolls = await fetchAll('payroll', '*');
  const targetPayrolls = payrolls.filter(p => {
    if (p.year < 2024) return false;
    if (p.year === 2024 && p.month < 11) return false;
    return true;
  });

  console.log(`Processing allocations for ${targetPayrolls.length} payslips...`);

  // 6. Allocate
  for (const p of targetPayrolls) {
    const key = `${p.employee_id}-${p.year}-${p.month}`;
    const pay = paymentMap[key];
    
    let updatedPayslipStatus = 'pending';
    let paidDate = null;
    
    if (pay && pay.entries.length > 0) {
      const totalPaid = pay.totalAmount;
      if (totalPaid > 0 && totalPaid >= p.net_salary - 0.01) {
        updatedPayslipStatus = 'paid';
        paidDate = new Date().toISOString();
      }

      let remainingPayslipBalance = p.net_salary;

      for (const entry of pay.entries) {
        let allocAmount = 0;
        if (remainingPayslipBalance > 0.01) {
           allocAmount = Math.min(entry.amount, remainingPayslipBalance);
           remainingPayslipBalance -= allocAmount;
        }

        if (allocAmount > 0.01) {
          const { error: allocErr } = await supabase.from('cashbook_payroll_allocations').insert({
            cashbook_entry_id: entry.id,
            payroll_id: p.id,
            allocated_amount: allocAmount
          });
          if (allocErr) console.error(`Error inserting allocation for payslip ${p.id}:`, allocErr);
        }
      }
    }

    // Update payslip status based on allocations
    const { error: updateErr } = await supabase.from('payroll').update({
      status: updatedPayslipStatus,
      paid_date: paidDate
    }).eq('id', p.id);
    
    if (updateErr) console.error(`Error updating payslip ${p.id}:`, updateErr);
  }

  console.log("Re-allocation completed successfully!");
}

run().catch(console.error);
