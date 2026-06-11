const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function getTargetPeriod(dateStr) {
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

async function run() {
  const { data: emps } = await supabase.from('employees').select('id, cqid');
  const empMap = {};
  emps.forEach(e => empMap[e.id] = e.cqid);

  // Sum contribution_scores by month
  const { data: scores } = await supabase.from('contribution_scores').select('employee_id, earnings_inr, tasks(task_date)');
  
  const contribSums = {};
  scores.forEach(s => {
    if (!s.tasks) return;
    const date = new Date(s.tasks.task_date);
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    const cqid = empMap[s.employee_id];
    const key = `${cqid}-${m}-${y}`;
    if (!contribSums[key]) contribSums[key] = 0;
    contribSums[key] += s.earnings_inr;
  });

  const csvContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  const paymentSums = {};
  records.forEach(row => {
    const cqid = row.Name;
    if (!cqid || !cqid.startsWith('CQID')) return;
    const { month, year } = getTargetPeriod(row.Date);
    const amount = parseFloat(row.Amount.replace(/[^\d.-]/g, '')) || 0;
    const key = `${cqid}-${month}-${year}`;
    if (!paymentSums[key]) paymentSums[key] = 0;
    paymentSums[key] += amount;
  });

  console.log("Comparison of newly imported Task Earnings vs Cashbook Payments:");
  let matchCount = 0;
  let diffCount = 0;
  for (const key in paymentSums) {
    const p = paymentSums[key];
    const c = contribSums[key] || 0;
    if (Math.abs(p - c) > 0.1) {
      console.log(`Mismatch ${key} | Cashbook: ${p} | Task Earnings: ${c} | Diff: ${c - p}`);
      diffCount++;
    } else {
      matchCount++;
    }
  }
  console.log(`Matched perfectly: ${matchCount}, Differences: ${diffCount}`);
}
run();
