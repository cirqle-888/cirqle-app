/** Shared payslip data shape — produced by build-payslip, consumed by the HTML
 *  template, the PDF generator, and stored as the email snapshot. */

export interface PayslipBand {
  band: '100' | '76-99' | '51-75' | '26-50' | '0-25'
  label: string          // e.g. "Excellent (76–99%)"
  count: number          // tasks in this band this month
  earnings: number       // employee earnings from this band (₹)
}

export interface PayslipTask {
  date: string           // YYYY-MM-DD
  title: string
  client: string
  scorePct: number
  earnings: number
}

export interface PayslipMonthEarning {
  month: number
  year: number
  label: string          // "May 2026"
  shortLabel: string     // "May"
  earnings: number
}

export interface PayslipData {
  employee: {
    id: string
    cqid: string
    name: string
    email: string
    designation: string | null
    role: string
  }
  period: {
    month: number
    year: number
    monthName: string     // "May"
    label: string         // "May 2026"
  }
  payslipNumber: string | null
  generatedAt: string     // ISO

  salary: {
    salaryType: string
    baseSalary: number
    commission: number
    bonus: number
    advancesDeducted: number
    otherDeductions: number
    netSalary: number
    status: string        // 'pending' | 'paid' | ...
    paidDate: string | null
  }

  performance: {
    rating: number        // current performance rating %
  }

  attendance: {
    workedDays: number    // distinct dates with a contribution this month
    daysInMonth: number   // calendar days in the month
  }

  contributionRanges: PayslipBand[]
  monthTasks: PayslipTask[]
  sixMonthEarnings: PayslipMonthEarning[]

  totals: {
    monthEarnings: number // sum of this month's contribution earnings
    monthTaskCount: number
    sixMonthTotal: number
  }

  company: {
    name: string
    email: string
    website: string
    phone: string
  }
}
