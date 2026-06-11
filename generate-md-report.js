const fs = require('fs');

const data = JSON.parse(fs.readFileSync('/Users/farooq/cirqle-app/verification_report_data.json', 'utf8'));

let md = `# Payroll Verification Report\n\n`;
md += `This report outlines the proposed mapping between the historical CSV payments and the payroll records in the system, based on the rules provided.\n\n`;

md += `### Summary\n`;
md += `- **Total CSV Payments**: ${data.length}\n`;
md += `- **Unambiguous Matches**: ${data.filter(d => !d.isAmbiguous).length}\n`;
md += `- **Ambiguous Records**: ${data.filter(d => d.isAmbiguous).length}\n\n`;

md += `### Proposed Allocations\n\n`;
md += `| Date | Employee | Payment Amount | Proposed Payroll Month | Reasoning | Matched Payroll | Amount Diff |\n`;
md += `|---|---|---|---|---|---|---|\n`;

for (const row of data) {
  let warning = row.isAmbiguous ? '⚠️ ' : '';
  let date = new Date(row.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  
  let payrollStatus = row.payrollFound;
  if (row.matchedPayrollId) {
     if (Math.abs(parseFloat(row.amountDiff)) > 10) {
        payrollStatus += ` ❌ Diff: ₹${row.amountDiff}`;
     } else {
        payrollStatus += ` ✅ Match`;
     }
  }

  md += `| ${warning}${date} | ${row.employee} | ₹${row.amount.toLocaleString('en-IN', {minimumFractionDigits:2})} | **${row.assignedMonth}** | ${row.reasoning} | ${payrollStatus} | ${row.amountDiff !== 'N/A' ? `₹${row.amountDiff}` : '-'} |\n`;
}

md += `\n### Ambiguous Records for Review\n\n`;
const ambiguous = data.filter(d => d.isAmbiguous);
if (ambiguous.length > 0) {
  for (const row of ambiguous) {
    md += `- **${row.date} - ${row.employee} (₹${row.amount})**\n`;
    md += `  - **Description**: ${row.desc}\n`;
    md += `  - **Reason**: ${row.reasoning}\n`;
  }
} else {
  md += `No ambiguous records found.\n`;
}

fs.writeFileSync('/Users/farooq/cirqle-app/report.md', md);
