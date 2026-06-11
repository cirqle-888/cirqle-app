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
  // Cashbook mapping: if paid late month (20-31), it belongs to current month.
  // If paid early month (1-15), it belongs to previous month.
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
  let month = date.getMonth() + 1; // 1-12
  let year = date.getFullYear();
  let day = date.getDate();

  // If we follow the old cycle: 23rd Oct to 22nd Nov = Nov payroll.
  // If we just follow strict calendar month, it's just month and year.
  // We'll calculate both to see which matches better, or just use calendar month.
  // Let's assume standard calendar month for task grouping, and see.
  return { month, year };
}

async function run() {
  const employees = await fetchAll('employees', 'id, cqid');
  const empMap = {};
  const empIdToCqid = {};
  employees.forEach(e => {
    empMap[e.cqid] = e.id;
    empIdToCqid[e.id] = e.cqid;
  });

  const scores = await fetchAll('contribution_scores', 'employee_id, earnings_inr, tasks(task_date)');
  
  const payrollTotals = {}; // cqid -> [ { month, year, total } ]
  
  scores.forEach(s => {
    if (!s.tasks) return;
    const { month, year } = getPayrollPeriod(s.tasks.task_date);
    const cqid = empIdToCqid[s.employee_id];
    const key = `${cqid}-${year}-${month.toString().padStart(2, '0')}`;
    if (!payrollTotals[key]) payrollTotals[key] = { cqid, month, year, taskEarnings: 0 };
    payrollTotals[key].taskEarnings += s.earnings_inr;
  });

  const csvContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  const cashbookEntries = [];
  records.forEach(row => {
    const cqid = row.Name;
    if (!cqid || !cqid.startsWith('CQID')) return;
    const amount = parseFloat(row.Amount.replace(/[^\d.-]/g, '')) || 0;
    cashbookEntries.push({
      date: row.Date,
      cqid,
      amount,
      desc: row.Description
    });
  });

  // Calculate FIFO allocation per employee
  // Group Payslips chronologically
  const empLedgers = {};
  for (const key in payrollTotals) {
    const p = payrollTotals[key];
    if (!empLedgers[p.cqid]) empLedgers[p.cqid] = { payslips: [], payments: [] };
    empLedgers[p.cqid].payslips.push(p);
  }
  
  for (const c of cashbookEntries) {
    if (!empLedgers[c.cqid]) empLedgers[c.cqid] = { payslips: [], payments: [] };
    empLedgers[c.cqid].payments.push(c);
  }

  // Sort and allocate
  let md = `# Historical FIFO Allocation Strategy\n\n`;

  for (const cqid in empLedgers) {
    const ledger = empLedgers[cqid];
    ledger.payslips.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
    ledger.payments.sort((a, b) => new Date(a.date) - new Date(b.date));

    md += `## Employee: ${cqid}\n`;
    md += `| Payslip (Sum of Tasks) | Cashbook Payment | Allocation Amount | Remaining Payslip Balance |\n`;
    md += `|---|---|---|---|\n`;

    let payIdx = 0;
    let slipIdx = 0;
    
    // Convert to working copies
    const slips = ledger.payslips.map(s => ({ ...s, balance: s.taskEarnings }));
    const payments = ledger.payments.map(p => ({ ...p, balance: p.amount }));

    while (slipIdx < slips.length || payIdx < payments.length) {
      if (slipIdx >= slips.length) {
        // Unallocated payments
        const p = payments[payIdx];
        if (p.balance > 0.01) {
          md += `| (No Payslip left) | ${p.date} (₹${p.amount.toFixed(2)}) | Unallocated: ₹${p.balance.toFixed(2)} | - |\n`;
        }
        payIdx++;
        continue;
      }
      if (payIdx >= payments.length) {
        // Unpaid payslips
        const s = slips[slipIdx];
        if (s.balance > 0.01) {
          md += `| ${s.month}/${s.year} (₹${s.taskEarnings.toFixed(2)}) | (No Payment left) | Unpaid: ₹${s.balance.toFixed(2)} | ₹${s.balance.toFixed(2)} |\n`;
        }
        slipIdx++;
        continue;
      }

      const s = slips[slipIdx];
      const p = payments[payIdx];

      if (s.balance <= 0.01) { slipIdx++; continue; }
      if (p.balance <= 0.01) { payIdx++; continue; }

      const allocAmount = Math.min(s.balance, p.balance);
      s.balance -= allocAmount;
      p.balance -= allocAmount;

      md += `| ${s.month}/${s.year} (₹${s.taskEarnings.toFixed(2)}) | ${p.date} (₹${p.amount.toFixed(2)}) | **₹${allocAmount.toFixed(2)}** | ₹${s.balance.toFixed(2)} |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync('/Users/farooq/.gemini/antigravity/brain/b3d9f8ce-3438-485e-a124-908bf3fb4a12/allocation_strategy.md', md);
  console.log("Analysis complete. Saved to allocation_strategy.md");
}
run();
