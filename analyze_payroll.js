const fs = require('fs');
const { parse } = require('csv-parse/sync');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function getTargetPeriod(dateStr) {
  // dateStr e.g. "23-Nov-2024"
  const parts = dateStr.split('-');
  const day = parseInt(parts[0], 10);
  const monthStr = parts[1];
  const year = parseInt(parts[2], 10);
  
  const monthMap = {
    'Jan': 1, 'Feb': 2, 'Mar': 3, 'Apr': 4, 'May': 5, 'Jun': 6,
    'Jul': 7, 'Aug': 8, 'Sep': 9, 'Oct': 10, 'Nov': 11, 'Dec': 12
  };
  let month = monthMap[monthStr];
  let targetMonth = month;
  let targetYear = year;
  let phase = '';

  if (day >= 20 && day <= 31) {
    // Phase 1: Payment on 23rd is for the current month's payroll (23rd-22nd cycle)
    // E.g. 23-Nov-2024 -> Nov 2024
    phase = 'Phase 1 (23rd-22nd)';
    targetMonth = month;
    targetYear = year;
  } else if (day >= 1 && day <= 15) {
    // Phase 2: Payment on 1st-6th is for previous month's payroll
    // E.g. 01-Jul-2025 -> Jun 2025
    phase = 'Phase 2 (1st of month)';
    targetMonth = month - 1;
    if (targetMonth === 0) {
      targetMonth = 12;
      targetYear = year - 1;
    }
  }

  return { targetMonth, targetYear, phase };
}

function parseAmount(amountStr) {
  if (!amountStr) return 0;
  let clean = amountStr.replace(/[^\d.-]/g, '');
  return parseFloat(clean) || 0;
}

async function run() {
  const { data: employees, error: empErr } = await supabase.from('employees').select('id, cqid, name');
  if (empErr) {
    console.error('Emp error:', empErr);
    return;
  }
  const empMap = {};
  const empIdToCqid = {};
  employees.forEach(e => {
    empMap[e.cqid] = e.id;
    empIdToCqid[e.id] = e.cqid;
  });

  const { data: payroll, error: pErr } = await supabase.from('payroll').select('*');
  if (pErr) {
    console.error('Payroll error:', pErr);
    return;
  }
  const payrollLookup = {};
  payroll.forEach(p => {
    const cqid = empIdToCqid[p.employee_id];
    if (!cqid) return;
    const key = `${cqid}-${p.month}-${p.year}`;
    if (!payrollLookup[key]) payrollLookup[key] = [];
    payrollLookup[key].push(p);
  });

  const csvContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });

  const allocations = [];
  const unmatchedCsv = [];
  const differences = [];
  let totalCashbookPayments = records.length;
  let totalPayrollSlips = payroll.length;

  // We need to keep track of matched payrolls to find unmatched payrolls
  const matchedPayrollIds = new Set();

  // Sort records by date to handle "Balance" payments correctly if any
  // Some rows are "Partial" and "Balance" for the same month.
  // We should aggregate payments by Employee + TargetPeriod to compare against the Payslip net_salary.

  const aggregatedPayments = {};

  for (const row of records) {
    const cqid = row.Name;
    const date = row.Date;
    const amount = parseAmount(row.Amount);
    
    if (!cqid || !cqid.startsWith('CQID')) continue; // Skip non-employees if any

    const { targetMonth, targetYear, phase } = getTargetPeriod(date);
    
    const key = `${cqid}-${targetMonth}-${targetYear}`;
    if (!aggregatedPayments[key]) {
      aggregatedPayments[key] = { cqid, targetMonth, targetYear, phase, totalPaid: 0, payments: [] };
    }
    aggregatedPayments[key].totalPaid += amount;
    aggregatedPayments[key].payments.push({ date, amount, desc: row.Description });
  }

  for (const key in aggregatedPayments) {
    const paymentGroup = aggregatedPayments[key];
    const matchingSlips = payrollLookup[key] || [];

    if (matchingSlips.length === 0) {
      unmatchedCsv.push(paymentGroup);
    } else if (matchingSlips.length === 1) {
      const slip = matchingSlips[0];
      matchedPayrollIds.add(slip.id);
      
      const slipAmount = slip.net_salary || 0;
      const diff = slipAmount - paymentGroup.totalPaid;
      
      allocations.push({ paymentGroup, slip });
      
      if (Math.abs(diff) > 0.1) {
        differences.push({ paymentGroup, slip, diff });
      }
    } else {
      // Multiple slips for the same month?
      unmatchedCsv.push({ ...paymentGroup, error: 'Multiple payslips found for period' });
    }
  }

  const unmatchedPayroll = payroll.filter(p => !matchedPayrollIds.has(p.id));

  // Write Report
  let md = `# Historical Payroll Allocation Verification Report\n\n`;
  md += `## Summary\n`;
  md += `- **Total Payroll Slips Found:** ${totalPayrollSlips}\n`;
  md += `- **Total Cashbook Payments Found:** ${totalCashbookPayments} (aggregated into ${Object.keys(aggregatedPayments).length} payment groups)\n`;
  md += `- **Proposed Allocations:** ${allocations.length}\n`;
  md += `- **Unmatched Cashbook Payments:** ${unmatchedCsv.length}\n`;
  md += `- **Unmatched Payroll Slips:** ${unmatchedPayroll.length}\n`;
  md += `- **Allocations with Amount Differences:** ${differences.length}\n\n`;

  md += `## Amount Differences (Paid vs Payslip)\n`;
  if (differences.length === 0) md += `None.\n`;
  else {
    md += `| Employee | Period | Paid Amount | Payslip Amount | Difference (Slip - Paid) |\n`;
    md += `|---|---|---|---|---|\n`;
    differences.forEach(d => {
      md += `| ${d.paymentGroup.cqid} | ${d.paymentGroup.targetMonth}/${d.paymentGroup.targetYear} | ₹${d.paymentGroup.totalPaid.toFixed(2)} | ₹${d.slip.net_salary.toFixed(2)} | ₹${d.diff.toFixed(2)} |\n`;
    });
  }
  md += `\n`;

  md += `## Proposed Allocations\n`;
  if (allocations.length === 0) md += `None.\n`;
  else {
    md += `| Employee | Cashbook Date(s) | Period Assumed | Paid Total | Payslip Number | Payslip Total |\n`;
    md += `|---|---|---|---|---|---|\n`;
    allocations.forEach(a => {
      const dates = a.paymentGroup.payments.map(p => p.date).join(', ');
      md += `| ${a.paymentGroup.cqid} | ${dates} | ${a.paymentGroup.targetMonth}/${a.paymentGroup.targetYear} | ₹${a.paymentGroup.totalPaid.toFixed(2)} | ${a.slip.payslip_number} | ₹${a.slip.net_salary.toFixed(2)} |\n`;
    });
  }
  md += `\n`;

  md += `## Unmatched Cashbook Payments\n`;
  if (unmatchedCsv.length === 0) md += `None.\n`;
  else {
    md += `| Employee | Payment Date(s) | Assumed Period | Amount | Note |\n`;
    md += `|---|---|---|---|---|\n`;
    unmatchedCsv.forEach(u => {
      const dates = u.payments.map(p => p.date).join(', ');
      md += `| ${u.cqid} | ${dates} | ${u.targetMonth}/${u.targetYear} | ₹${u.totalPaid.toFixed(2)} | No matching payslip found |\n`;
    });
  }
  md += `\n`;

  md += `## Unmatched Payroll Slips (No Payment Found)\n`;
  if (unmatchedPayroll.length === 0) md += `None.\n`;
  else {
    md += `| Employee | Period | Payslip Number | Net Salary |\n`;
    md += `|---|---|---|---|\n`;
    unmatchedPayroll.forEach(p => {
      const cqid = empIdToCqid[p.employee_id];
      md += `| ${cqid} | ${p.month}/${p.year} | ${p.payslip_number} | ₹${p.net_salary.toFixed(2)} |\n`;
    });
  }
  md += `\n`;

  fs.writeFileSync('/Users/farooq/.gemini/antigravity/brain/b3d9f8ce-3438-485e-a124-908bf3fb4a12/verification_report.md', md);
  console.log('Verification report generated.');
}

run();
