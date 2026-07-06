/**
 * Timeline sentence templates — one place mapping entity_type + action to a
 * human sentence and a deep link. Design: docs/cirqle-connect/UI_FLOW.md §1.
 *
 * Pure module (no server deps) so it is unit-testable and usable client-side.
 */

import type { ActivityCategory } from './log'

export interface TimelineRowInput {
  entity_type: string
  entity_id:   string | null
  action:      string
  category:    string | null
  note:        string | null
  detail:      unknown
  /** Label writers may stash in detail.label (e.g. client name, invoice number). */
}

/** Best-effort human label from the detail payload. */
function detailLabel(detail: unknown): string | null {
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>
    if (typeof d.label === 'string' && d.label) return d.label
  }
  return null
}

const ENTITY_NOUN: Record<string, string> = {
  task: 'task', contribution: 'contribution', employee: 'employee',
  payroll: 'payroll', invoice: 'invoice', cashbook: 'cashbook entry',
  score: 'score', note: 'note', client: 'client', project: 'project',
  file: 'file', message: 'message', approval: 'approval',
  kb_document: 'document', auth: 'account', setting: 'setting',
  leave: 'leave request', quotation: 'quotation',
}

const ACTION_VERB: Record<string, string> = {
  created: 'created', edited: 'updated', deleted: 'deleted', restored: 'restored',
  status_changed: 'changed the status of', assigned: 'assigned',
  contribution_saved: 'saved a contribution on', scored: 'scored',
  score_recalculated: 'recalculated scores for',
  payroll_generated: 'generated payroll for', marked_paid: 'marked as paid',
  advance_added: 'added an advance for', credit_added: 'added a credit for',
  employee_created: 'added employee', employee_archived: 'archived employee',
  designation_changed: 'changed the designation of',
  uploaded: 'uploaded', archived: 'archived', unarchived: 'restored',
  sent: 'sent', paid: 'recorded payment for', payment_received: 'recorded a payment on',
  expense_added: 'added an expense', generated: 'generated',
  login: 'signed in', changed: 'changed', requested: 'requested',
  approved: 'approved', rejected: 'rejected', published: 'published',
  accepted: 'marked as accepted', note: 'added a note on',
  mention: 'mentioned someone in',
}

/**
 * Render "verb + object" for a row; the UI prefixes the actor name.
 * e.g. → "updated client Sea Star Supermarket"
 */
export function timelineSentence(row: TimelineRowInput): string {
  const noun  = ENTITY_NOUN[row.entity_type] ?? row.entity_type
  const label = detailLabel(row.detail)
  const verb  = ACTION_VERB[row.action] ?? row.action.replace(/_/g, ' ')
  const object = label ? `${noun} “${label}”` : `a ${noun}`
  // Verbs that already name their object read better without the noun phrase:
  if (row.action === 'login') return 'signed in'
  if (row.action === 'note' && row.note) return `noted: “${row.note}”`
  return `${verb} ${object}`
}

/** Deep link for a timeline row; null when the target has no page. */
export function timelineHref(row: TimelineRowInput): string | null {
  const id = row.entity_id
  switch (row.entity_type) {
    case 'task':         return id ? `/dashboard/tasks?task=${id}` : '/dashboard/tasks'
    case 'contribution': return '/dashboard/contributions'
    case 'employee':     return id ? `/dashboard/employees/${id}` : null
    case 'payroll':      return '/dashboard/payroll'
    case 'invoice':      return '/dashboard/invoices'
    case 'quotation':    return '/dashboard/quotations'
    case 'cashbook':     return '/dashboard/cashbook'
    case 'client':       return '/dashboard/clients'
    case 'project':      return id ? `/dashboard/advertising/${id}` : '/dashboard/advertising'
    case 'kb_document':  return null // KB arrives in Wave E
    case 'setting':      return '/dashboard/settings'
    default:             return null
  }
}

/** Categories the viewer may see. Finance/billing require timeline.view_finance. */
export const FINANCE_CATEGORIES: ActivityCategory[] = ['billing', 'finance']

export const ALL_CATEGORIES: { key: ActivityCategory; label: string }[] = [
  { key: 'tasks',       label: 'Tasks' },
  { key: 'billing',     label: 'Billing' },
  { key: 'chat',        label: 'Chat' },
  { key: 'files',       label: 'Files' },
  { key: 'advertising', label: 'Advertising' },
  { key: 'crm',         label: 'CRM' },
  { key: 'employees',   label: 'Employees' },
  { key: 'finance',     label: 'Finance' },
]
