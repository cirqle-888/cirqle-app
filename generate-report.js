const fs = require('fs');
const { parse } = require('csv-parse/sync');
require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const fileContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf8');
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true
  });

  const { data: employees } = await supabase.from('employees').select('id, name, cqid');
  const { data: payrolls } = await supabase.from('payroll').select('id, employee_id, month, year, net_salary, payslip_number');
  const { data: cashbook } = await supabase.from('cashbook_entries').select('id, entry_date, amount_inr, description');

  console.log(`Found ${payrolls.length} payroll records`);
  console.log(`Found ${cashbook.length} cashbook entries`);
  console.log(`Found ${records.length} CSV payment records`);

  const report = [];

  for (const row of records) {
    const dateStr = row.Date;
    const date = new Date(dateStr);
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = date.getFullYear();
    const desc = row.Description;
    const cqid = desc.match(/CQID\d{3}/)?.[0] || row.Name;
    const amountStr = row.Amount.replace(/[^0-9.-]+/g, '');
    const amount = parseFloat(amountStr);

    const emp = employees.find(e => e.cqid === cqid);
    
    let targetMonth = month;
    let targetYear = year;
    let reasoning = '';
    let isAmbiguous = false;

    // Check descriptions first
    const lowerDesc = desc.toLowerCase();
    
    if (lowerDesc.includes('partial')) {
      reasoning = 'Description indicates Partial payment';
      // Partial usually belongs to the previous month if early in the month, or same month if late.
      if (day <= 15) {
        targetMonth = month - 1;
        if (targetMonth === 0) { targetMonth = 12; targetYear--; }
      }
    } else if (lowerDesc.includes('balance')) {
      reasoning = 'Description indicates Balance payment';
      if (day <= 15) {
        targetMonth = month - 1;
        if (targetMonth === 0) { targetMonth = 12; targetYear--; }
      }
      if (lowerDesc.includes('june 20')) {
        targetMonth = 6;
        targetYear = 2025;
      }
    } else if (lowerDesc.includes('last month pending')) {
      reasoning = 'Description indicates Last Month Pending';
      // If paid in Nov, it's for Oct
      targetMonth = month - 1;
      if (targetMonth === 0) { targetMonth = 12; targetYear--; }
    } else if (lowerDesc.includes('july, august')) {
      reasoning = 'Description indicates Multi-month (July, August)';
      isAmbiguous = true;
    } else {
      // Phase 1 (Old Method) vs Phase 2 (New Method)
      // Phase 1: around 23rd
      if (day >= 20 && day <= 31) {
        // Payment on 23-Nov-2024 = Salary for work Oct-Nov. Let's call it November payroll.
        targetMonth = month;
        reasoning = 'Date Rule (Phase 1: Old Method, ~23rd of month)';
      } else if (day >= 1 && day <= 10) {
        // Phase 2: beginning of month (e.g. 1st to 6th) -> previous month
        targetMonth = month - 1;
        if (targetMonth === 0) { targetMonth = 12; targetYear--; }
        reasoning = 'Date Rule (Phase 2: New Method, early month -> prev month)';
      } else {
        reasoning = 'Date does not match expected Phase 1 or 2 rules';
        isAmbiguous = true;
      }
    }

    // Try to find matching payroll record
    const empPayrolls = payrolls.filter(p => p.employee_id === emp?.id);
    const matchedPayroll = empPayrolls.find(p => p.month === targetMonth && p.year === targetYear);
    
    // Find cashbook entry that matches date and amount
    const matchedCb = cashbook.filter(c => {
      const cDate = new Date(c.entry_date);
      // matching date
      if (cDate.getFullYear() !== year || cDate.getMonth() + 1 !== month || cDate.getDate() !== day) return false;
      // matching amount
      if (Math.abs(c.amount_inr - amount) > 10) return false; // 10 rupee tolerance
      return true;
    });

    report.push({
      employee: cqid,
      date: dateStr,
      amount: amount,
      desc: desc,
      assignedMonth: `${targetYear}-${String(targetMonth).padStart(2, '0')}`,
      reasoning,
      isAmbiguous,
      payrollFound: matchedPayroll ? `Yes (Net: ${matchedPayroll.net_salary})` : 'No',
      amountDiff: matchedPayroll ? (amount - matchedPayroll.net_salary).toFixed(2) : 'N/A',
      matchedPayrollId: matchedPayroll?.id,
      matchedCashbookId: matchedCb.length > 0 ? matchedCb[0].id : null,
      multipleCbMatched: matchedCb.length > 1
    });
  }

  fs.writeFileSync('/Users/farooq/cirqle-app/verification_report_data.json', JSON.stringify(report, null, 2));
  console.log('Report data generated at verification_report_data.json');
}

run().catch(console.error);
