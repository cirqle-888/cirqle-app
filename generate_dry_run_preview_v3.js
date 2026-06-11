const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAll(table, select = '*') {
  let allData = [];
  let from = 0;
  const size = 1000;
  while (true) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + size - 1);
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
  const day = parseInt(parts[0], 10);
  const monthMap = { 'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12 };
  let month = monthMap[parts[1]];
  let year = parseInt(parts[2], 10);
  
  if (day >= 20 && day <= 31) return { month, year };
  if (day >= 1 && day <= 15) {
    let m = month - 1;
    let y = year;
    if (m === 0) { m = 12; y = year - 1; }
    return { month: m, year: y };
  }
  return { month, year };
}

function getPayrollPeriod(taskDateStr) {
  const date = new Date(taskDateStr);
  let month = date.getMonth() + 1;
  let year = date.getFullYear();
  return { month, year };
}

async function run() {
  const employees = await fetchAll('employees', 'id, cqid');
  const empIdToCqid = {};
  const cqidToEmpId = {};
  employees.forEach(e => {
    empIdToCqid[e.id] = e.cqid;
    cqidToEmpId[e.cqid] = e.id;
  });

  const scores = await fetchAll('contribution_scores', 'employee_id, earnings_inr, tasks(task_date)');
  
  const payrollMap = {}; // calculated from scores
  scores.forEach(s => {
    if (!s.tasks) return;
    const { month, year } = getPayrollPeriod(s.tasks.task_date);
    if (year < 2024 || (year === 2024 && month < 11)) return;
    
    const cqid = empIdToCqid[s.employee_id];
    const key = `${cqid}-${year}-${month}`;
    if (!payrollMap[key]) payrollMap[key] = { cqid, month, year, taskEarnings: 0 };
    payrollMap[key].taskEarnings += s.earnings_inr;
  });

  // Fetch EXISTING payroll records to know how many need to be UPDATED vs CREATED
  const existingPayroll = await fetchAll('payroll', 'id, employee_id, month, year, net_salary');
  let existingPayrollMap = {};
  existingPayroll.forEach(p => {
    const cqid = empIdToCqid[p.employee_id];
    const key = `${cqid}-${p.year}-${p.month}`;
    existingPayrollMap[key] = p;
  });

  const csvContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  const paymentMap = {};
  let totalCashbookEntriesToCreate = 0;
  
  records.forEach(row => {
    const cqid = row.Name;
    if (!cqid || !cqid.startsWith('CQID')) return;
    
    const { month, year } = getCashbookTargetPeriod(row.Date);
    const amount = parseFloat(row.Amount.replace(/[^\d.-]/g, '')) || 0;
    
    // Each row in CSV is ONE cashbook entry to create.
    totalCashbookEntriesToCreate++;
    
    const key = `${cqid}-${year}-${month}`;
    if (!paymentMap[key]) paymentMap[key] = { cqid, month, year, amount: 0, count: 0 };
    paymentMap[key].amount += amount;
    paymentMap[key].count++; // This is how many allocations will be created for this month
  });

  const allKeys = new Set([...Object.keys(payrollMap), ...Object.keys(paymentMap)]);
  
  let totalPayslipsToUpdate = 0;
  let totalAllocationsToCreate = 0;
  let mismatchedPeriods = [];

  allKeys.forEach(key => {
    const slip = payrollMap[key];
    const pay = paymentMap[key];
    const existing = existingPayrollMap[key];
    
    const payslipAmount = slip ? slip.taskEarnings : 0;
    const cashbookAmount = pay ? pay.amount : 0;
    
    // Will update or insert a payroll record if we have tasks or cashbook
    if (payslipAmount > 0 || cashbookAmount > 0) {
      // If it exists, we update it. If it doesn't, we create it.
      // The user asked "Total payslips to be updated" (meaning affected)
      totalPayslipsToUpdate++;
    }

    if (pay && pay.count > 0) {
      // If we have a payslip and a payment for this period, an allocation is created for EACH cashbook entry
      // because multiple payments can point to the same payroll record.
      totalAllocationsToCreate += pay.count;
    }

    const diff = cashbookAmount - payslipAmount;
    if (Math.abs(diff) > 0.01) {
      const cqid = slip ? slip.cqid : pay.cqid;
      const m = slip ? slip.month : pay.month;
      const y = slip ? slip.year : pay.year;
      mismatchedPeriods.push(`- **${cqid} (${m}/${y})**: Payslip = ₹${payslipAmount.toFixed(2)}, Cashbook = ₹${cashbookAmount.toFixed(2)} (Diff: ₹${diff.toFixed(2)})`);
    }
  });

  let md = `# Execution Statistics\n\n`;
  md += `- **Total Payslips to be Updated/Created:** ${totalPayslipsToUpdate}\n`;
  md += `- **Total Cashbook Entries to be Created:** ${totalCashbookEntriesToCreate}\n`;
  md += `- **Total Allocation Records to be Created:** ${totalAllocationsToCreate}\n\n`;
  md += `### Periods Where Earnings and Payments Do Not Match\n`;
  if (mismatchedPeriods.length > 0) {
    md += mismatchedPeriods.join('\n');
  } else {
    md += `All periods match perfectly!`;
  }

  fs.writeFileSync('/Users/farooq/.gemini/antigravity/brain/b3d9f8ce-3438-485e-a124-908bf3fb4a12/execution_stats.md', md);
  console.log("Stats calculated.");
}
run();
