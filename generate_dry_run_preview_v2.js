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
  employees.forEach(e => {
    empIdToCqid[e.id] = e.cqid;
  });

  const scores = await fetchAll('contribution_scores', 'employee_id, earnings_inr, tasks(task_date)');
  
  const payrollMap = {}; // key: cqid-year-month
  
  scores.forEach(s => {
    if (!s.tasks) return;
    const { month, year } = getPayrollPeriod(s.tasks.task_date);
    
    // Ignore before Nov 2024
    if (year < 2024 || (year === 2024 && month < 11)) return;

    const cqid = empIdToCqid[s.employee_id];
    const key = `${cqid}-${year}-${month}`;
    if (!payrollMap[key]) payrollMap[key] = { cqid, month, year, taskEarnings: 0 };
    payrollMap[key].taskEarnings += s.earnings_inr;
  });

  const csvContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  const paymentMap = {}; // key: cqid-year-month
  records.forEach(row => {
    const cqid = row.Name;
    if (!cqid || !cqid.startsWith('CQID')) return;
    
    const { month, year } = getCashbookTargetPeriod(row.Date);
    const amount = parseFloat(row.Amount.replace(/[^\d.-]/g, '')) || 0;
    
    const key = `${cqid}-${year}-${month}`;
    if (!paymentMap[key]) paymentMap[key] = { cqid, month, year, amount: 0, dates: [] };
    paymentMap[key].amount += amount;
    paymentMap[key].dates.push(row.Date);
  });

  // Combine keys to generate report
  const allKeys = new Set([...Object.keys(payrollMap), ...Object.keys(paymentMap)]);
  const keysArray = Array.from(allKeys).sort((a, b) => {
    const [c1, y1, m1] = a.split('-');
    const [c2, y2, m2] = b.split('-');
    if (c1 !== c2) return c1.localeCompare(c2);
    if (y1 !== y2) return parseInt(y1) - parseInt(y2);
    return parseInt(m1) - parseInt(m2);
  });

  let md = `# Final Preview: Month-by-Month Allocation\n\n`;
  md += `| Employee | Payroll Period | Payslip Amount | Cashbook Amount | Difference (Cash - Payslip) | Allocation Status |\n`;
  md += `|---|---|---|---|---|---|\n`;

  keysArray.forEach(key => {
    const slip = payrollMap[key];
    const pay = paymentMap[key];
    
    const cqid = slip ? slip.cqid : pay.cqid;
    const month = slip ? slip.month : pay.month;
    const year = slip ? slip.year : pay.year;
    
    const payslipAmount = slip ? slip.taskEarnings : 0;
    const cashbookAmount = pay ? pay.amount : 0;
    const diff = cashbookAmount - payslipAmount;
    
    let status = '';
    if (payslipAmount === 0 && cashbookAmount > 0) status = 'Unmatched Payment (No Tasks)';
    else if (cashbookAmount === 0 && payslipAmount > 0) status = 'Unpaid Payslip (No Payment)';
    else if (Math.abs(diff) < 0.01) status = 'Fully Paid / Exact Match';
    else if (diff > 0) status = 'Overpaid';
    else status = 'Partially Paid';

    md += `| ${cqid} | ${month}/${year} | ₹${payslipAmount.toFixed(2)} | ₹${cashbookAmount.toFixed(2)} | ₹${diff.toFixed(2)} | ${status} |\n`;
  });

  fs.writeFileSync('/Users/farooq/.gemini/antigravity/brain/b3d9f8ce-3438-485e-a124-908bf3fb4a12/final_dry_run_preview.md', md);
  console.log("Dry run complete. Saved to final_dry_run_preview.md");
}
run();
