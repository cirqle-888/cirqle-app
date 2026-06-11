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
  console.log("Starting Execution Script...");

  // 1. Get Setup Data
  const employees = await fetchAll('employees', 'id, cqid');
  const empIdToCqid = {};
  const cqidToEmpId = {};
  employees.forEach(e => {
    empIdToCqid[e.id] = e.cqid;
    cqidToEmpId[e.cqid] = e.id;
  });

  const { data: bankAccounts } = await supabase.from('bank_accounts').select('id').limit(1);
  const bankAccountId = bankAccounts && bankAccounts.length > 0 ? bankAccounts[0].id : null;
  
  const { data: categories } = await supabase.from('cashbook_categories').select('id').ilike('name', '%Salary%').eq('type', 'outflow').limit(1);
  const categoryId = categories && categories.length > 0 ? categories[0].id : null;
  
  if (!bankAccountId) throw new Error("No bank account found!");

  // 2. Fetch Earnings
  const scores = await fetchAll('contribution_scores', 'employee_id, earnings_inr, tasks(task_date)');
  const payrollMap = {}; 
  scores.forEach(s => {
    if (!s.tasks) return;
    const { month, year } = getPayrollPeriod(s.tasks.task_date);
    if (year < 2024 || (year === 2024 && month < 11)) return; // Ignore < Nov 2024
    
    const cqid = empIdToCqid[s.employee_id];
    const key = `${cqid}-${year}-${month}`;
    if (!payrollMap[key]) payrollMap[key] = { employee_id: s.employee_id, cqid, month, year, taskEarnings: 0 };
    payrollMap[key].taskEarnings += s.earnings_inr;
  });

  // 3. Parse CSV
  const csvContent = fs.readFileSync('/Users/farooq/Downloads/historical salary payment.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  
  const paymentMap = {};
  records.forEach(row => {
    const cqid = row.Name;
    if (!cqid || !cqid.startsWith('CQID')) return;
    
    const { month, year } = getCashbookTargetPeriod(row.Date);
    const amount = parseFloat(row.Amount.replace(/[^\d.-]/g, '')) || 0;
    
    const key = `${cqid}-${year}-${month}`;
    if (!paymentMap[key]) paymentMap[key] = { cqid, month, year, entries: [] };
    
    // We store exact date in YYYY-MM-DD
    const parts = row.Date.split('-'); // e.g. "23-Nov-2024"
    const mStr = String(month).padStart(2, '0');
    // We just parse the date properly
    const monthMap = { 'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12 };
    const exactM = String(monthMap[parts[1]]).padStart(2, '0');
    const exactD = parts[0].padStart(2, '0');
    const exactY = parts[2];
    const isoDate = `${exactY}-${exactM}-${exactD}`;

    paymentMap[key].entries.push({
      date: isoDate,
      amount,
      desc: row.Description || 'Historical Import'
    });
  });

  // 4. Fetch Existing Payroll
  const existingPayroll = await fetchAll('payroll', '*');
  let existingPayrollMap = {};
  existingPayroll.forEach(p => {
    const cqid = empIdToCqid[p.employee_id];
    const key = `${cqid}-${p.year}-${p.month}`;
    existingPayrollMap[key] = p;
  });

  const allKeys = new Set([...Object.keys(payrollMap), ...Object.keys(paymentMap)]);
  
  console.log(`Processing ${allKeys.size} periods...`);

  for (const key of allKeys) {
    const slip = payrollMap[key];
    const pay = paymentMap[key];
    
    const employee_id = slip ? slip.employee_id : cqidToEmpId[pay.cqid];
    const cqid = slip ? slip.cqid : pay.cqid;
    const month = slip ? slip.month : pay.month;
    const year = slip ? slip.year : pay.year;
    const taskEarnings = slip ? slip.taskEarnings : 0;
    const existing = existingPayrollMap[key];

    let currentPayrollId = null;
    let netSalaryDiffers = false;
    let updatedPayslipStatus = 'pending';

    // Calculate if it's fully paid
    const totalPaid = pay ? pay.entries.reduce((sum, e) => sum + e.amount, 0) : 0;
    if (totalPaid > 0 && totalPaid >= taskEarnings - 0.01) {
      updatedPayslipStatus = 'paid';
    }

    // A. Create or Update Payroll
    if (existing) {
      currentPayrollId = existing.id;
      // Append note if value changed
      const oldVal = parseFloat(existing.net_salary);
      const newVal = parseFloat(taskEarnings);
      
      let updates = { status: updatedPayslipStatus };
      if (updatedPayslipStatus === 'paid') updates.paid_date = new Date().toISOString();

      if (Math.abs(oldVal - newVal) > 0.01) {
        netSalaryDiffers = true;
        const noteAppend = `\n[System]: Historical earnings import updated net_salary from ₹${oldVal.toFixed(2)} to ₹${newVal.toFixed(2)}`;
        const newNotes = (existing.notes || '') + noteAppend;
        
        updates.net_salary = newVal;
        updates.commission_earned = newVal; // assuming commission_only
        updates.notes = newNotes;
      } else if (existing.status !== updatedPayslipStatus) {
        // Just update status
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await supabase.from('payroll').update(updates).eq('id', currentPayrollId);
        if (error) console.error(`Error updating payroll ${key}:`, error);
      }

    } else {
      // Create new payroll
      const payslip_number = `PAY-${cqid.replace('CQID', '')}-${String(month).padStart(2, '0')}${String(year).slice(2)}`;
      const { data: newP, error } = await supabase.from('payroll').insert({
        employee_id,
        month,
        year,
        base_salary: 0,
        commission_earned: taskEarnings,
        net_salary: taskEarnings,
        status: updatedPayslipStatus,
        payslip_number,
        paid_date: updatedPayslipStatus === 'paid' ? new Date().toISOString() : null,
        notes: '[System]: Created from historical earnings import.'
      }).select('id').single();

      if (error) {
        console.error(`Error creating payroll ${key}:`, error);
      } else {
        currentPayrollId = newP.id;
      }
    }

    // B. Create Cashbook Entries and Allocations
    if (pay && pay.entries.length > 0 && currentPayrollId) {
      // We will track how much is left to allocate on the payslip
      let remainingPayslipBalance = taskEarnings;

      for (const entry of pay.entries) {
        // Insert Cashbook Entry
        const { data: cb, error: cbErr } = await supabase.from('cashbook_entries').insert({
          entry_date: entry.date,
          amount: entry.amount,
          amount_inr: entry.amount,
          currency: 'INR',
          type: 'outflow', // Salary is outflow!
          category_id: categoryId,
          bank_account_id: bankAccountId,
          description: entry.desc,
          employee_id,
          exchange_rate: 1,
          is_billable: false,
          notes: '[System]: Historical CSV Import'
        }).select('id').single();

        if (cbErr) {
          console.error(`Error inserting cashbook ${key}:`, cbErr);
          continue;
        }

        // Calculate Allocation (cap at what's left on the payslip to avoid negative unallocated)
        // If payslip is 0, we can't allocate. If payment is larger than payslip, remainder is unallocated cashbook balance.
        let allocAmount = 0;
        if (remainingPayslipBalance > 0.01) {
           allocAmount = Math.min(entry.amount, remainingPayslipBalance);
           remainingPayslipBalance -= allocAmount;
        }

        if (allocAmount > 0.01) {
          const { error: allocErr } = await supabase.from('cashbook_payroll_allocations').insert({
            cashbook_entry_id: cb.id,
            payroll_id: currentPayrollId,
            allocated_amount: allocAmount
          });
          if (allocErr) console.error(`Error inserting allocation ${key}:`, allocErr);
        }
      }
    }
  }

  console.log("Database alignment completed successfully!");
}

run().catch(console.error);
