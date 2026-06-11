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
    const { data } = await supabase.from(table).select(select).range(from, from + size - 1);
    if (!data || data.length === 0) break;
    allData = allData.concat(data);
    from += size;
  }
  return allData;
}

async function run() {
  const employees = await fetchAll('employees', 'id, cqid');
  const empMap = {};
  employees.forEach(e => empMap[e.id] = e.cqid);

  const scores = await fetchAll('contribution_scores', 'employee_id, earnings_inr');
  const taskSums = {};
  scores.forEach(s => {
    const cqid = empMap[s.employee_id];
    if (!taskSums[cqid]) taskSums[cqid] = 0;
    taskSums[cqid] += s.earnings_inr;
  });

  const csvContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  const cashSums = {};
  records.forEach(row => {
    const cqid = row.Name;
    if (!cqid || !cqid.startsWith('CQID')) return;
    const amount = parseFloat(row.Amount.replace(/[^\d.-]/g, '')) || 0;
    if (!cashSums[cqid]) cashSums[cqid] = 0;
    cashSums[cqid] += amount;
  });

  for (const cqid in taskSums) {
    console.log(`${cqid} | Task Earnings: ${taskSums[cqid]} | Cashbook: ${cashSums[cqid] || 0} | Diff: ${(cashSums[cqid] || 0) - taskSums[cqid]}`);
  }
}
run();
