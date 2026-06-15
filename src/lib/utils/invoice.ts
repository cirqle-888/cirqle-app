/**
 * Generate invoice number: INV-YYMM-ClientCode
 * e.g. INV-2505-001
 */
export function generateInvoiceNumber(date: Date, clientCode: string): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `INV-${yy}${mm}-${clientCode}`
}

/**
 * Generate quotation number: QUO-YYMM-ClientCode
 */
export function generateQuotationNumber(date: Date, clientCode: string): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `QUO-${yy}${mm}-${clientCode}`
}

/**
 * Check if invoice is overdue
 */
export function isOverdue(dueDate: string, status: string, issueDate?: string): boolean {
  if (status === 'paid' || status === 'cancelled' || status === 'bad_debt') return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  if (dueDate) {
    const due = new Date(dueDate)
    if (!isNaN(due.getTime())) return due < today
  }
  // No due_date set — treat as net-30 from issue date
  if (issueDate) {
    const iss = new Date(issueDate)
    if (!isNaN(iss.getTime())) {
      iss.setDate(iss.getDate() + 30)
      return iss < today
    }
  }
  return false
}

/**
 * Get status color for UI
 */
export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    draft:     'bg-gray-500/20 text-gray-400 border border-gray-500/30',
    reviewed:  'bg-violet-500/20 text-violet-400 border border-violet-500/30',
    finalized: 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30',
    sent:      'bg-blue-500/20 text-blue-400 border border-blue-500/30',
    partial:   'bg-orange-500/20 text-orange-400 border border-orange-500/30',
    paid:      'bg-green-500/20 text-green-400 border border-green-500/30',
    overdue:   'bg-red-500/20 text-red-400 border border-red-500/30',
    cancelled: 'bg-gray-500/20 text-gray-500 border border-gray-500/20',
    bad_debt:  'bg-red-900/30 text-red-500 border border-red-900/40',
    approved:  'bg-green-500/20 text-green-400 border border-green-500/30',
    rejected:  'bg-red-500/20 text-red-400 border border-red-500/30',
    converted: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
    pending:   'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    in_progress: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    done:      'bg-green-500/20 text-green-400 border border-green-500/30',
    invoiced:  'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  }
  return colors[status] || 'bg-gray-500/20 text-gray-400 border border-gray-500/30'
}

export function getStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft:       'Draft',
    reviewed:    'Reviewed',
    finalized:   'Finalized',
    sent:        'Sent',
    partial:     'Partial',
    paid:        'Paid',
    overdue:     'Overdue',
    cancelled:   'Cancelled',
    bad_debt:    'Bad Debt',
    approved:    'Approved',
    rejected:    'Rejected',
    converted:   'Converted',
    pending:     'Pending',
    in_progress: 'In Progress',
    done:        'Done',
    invoiced:    'Invoiced',
  }
  return labels[status] || status
}

/** Next logical action for an invoice status */
export function getNextAction(status: string): { label: string; next: string } | null {
  const map: Record<string, { label: string; next: string }> = {
    draft:     { label: 'Mark Reviewed', next: 'reviewed' },
    reviewed:  { label: 'Mark Sent',     next: 'sent' },
    sent:      { label: 'Record Payment', next: 'partial' },
    partial:   { label: 'Mark Paid',     next: 'paid' },
  }
  return map[status] || null
}

/** Whether an invoice is editable (items can be changed) */
export function isEditable(status: string): boolean {
  return status === 'draft' || status === 'reviewed'
}

/** Format a billing period label */
export function formatBillingPeriod(start?: string, end?: string): string {
  if (!start) return '—'
  const d = new Date(start + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}
