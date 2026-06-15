import type { FieldDef } from '../types'
import { normalizeDate, norm } from '../engine'

const VALID_STATUSES   = ['pending','in_progress','delivered','done','invoiced','cancelled'] as const
const VALID_CURRENCIES = ['INR','AED','SAR','USD','QAR','GBP','EUR'] as const
const VALID_INTERVALS  = ['daily','weekly','biweekly','monthly'] as const

export const JOB_FIELDS: FieldDef[] = [
  { col: 'id',                   db: 'id',                   example: '', notes: 'Leave blank for new rows · REQUIRED in Update mode' },
  { col: 'task_number',          db: 'task_number',          example: '', notes: 'Auto-assigned if blank — set only if restoring historical data',
    aliases: ['number','task#','no','task_no'],
    parse: (v) => { const n = v.replace(/^#/,'').trim(); return n ? parseInt(n) : null },
    validate: (v) => v !== null && isNaN(Number(v)) ? 'task_number must be a whole number' : null,
    default: null },
  { col: 'title',                db: 'title',                example: 'Social Media Pack Jun', notes: 'Task title', req: true },
  { col: 'client_name_or_code',  db: false,                  example: 'Sea Star Supermarket',  notes: 'Client name or code',
    aliases: ['client'],
    validate: (v, _row, ctx) => v && !ctx.clientMap[norm(v)] ? { warn: `Client "${v}" not found` } : null },
  { col: 'service_name',         db: false,                  example: 'Offer Flyer',           notes: 'Service name',
    aliases: ['service'],
    validate: (v, _row, ctx) => v && !ctx.serviceMap[norm(v)] ? { warn: `Service "${v}" not found` } : null },
  { col: 'task_date',            db: 'task_date',            example: '04-Dec-2023',            notes: 'DD-MMM-YYYY (e.g. 04-Dec-2023) or DD-MM-YYYY', req: true,
    parse: (v) => normalizeDate(v),
    validate: (v) => v && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? 'task_date must be DD-MMM-YYYY (e.g. 04-Dec-2023)' : null },
  { col: 'billing_amount',       db: 'billing_amount',       example: '500', notes: 'Amount in task currency',
    parse: (v) => parseFloat(v) || 0, default: 0 },
  { col: 'billing_amount_inr',   db: 'billing_amount_inr',   example: '500', notes: 'Amount in INR (if currency ≠ INR, set both)',
    aliases: ['amount_inr'],
    parse: (v) => v ? parseFloat(v) : null, default: null },
  { col: 'currency',             db: 'currency',             example: 'INR', notes: VALID_CURRENCIES.join(' | '), default: 'INR' },
  { col: 'quantity',             db: 'quantity',             example: '1',   notes: 'Number of units (default 1)', default: 1,
    parse: (v) => parseFloat(v) || 1 },
  { col: 'status',               db: 'status',               example: 'done',notes: VALID_STATUSES.join(' | '), default: 'done',
    aliases: ['task_status'],
    validate: (v) => v && !VALID_STATUSES.includes(v as any) ? `status "${v}" invalid — use: ${VALID_STATUSES.join(', ')}` : null },
  { col: 'description',          db: 'description',          example: '',    notes: 'Optional task notes', default: null },
  { col: 'is_recurring',         db: 'is_recurring',         example: 'false', notes: 'true / false', default: false,
    parse: (v) => ['true','TRUE','1'].includes(v) },
  { col: 'recurring_interval',   db: 'recurring_interval',   example: '',    notes: VALID_INTERVALS.join(' | '), default: null,
    validate: (v) => v && !VALID_INTERVALS.includes(v as any) ? `recurring_interval "${v}" invalid` : null },
  { col: 'recurring_end_date',   db: 'recurring_end_date',   example: '',    notes: 'DD-MMM-YYYY — when the recurring series ends', default: null,
    parse: (v) => v ? normalizeDate(v) : null,
    validate: (v) => v && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? 'recurring_end_date must be DD-MMM-YYYY (e.g. 31-Dec-2026)' : null },
]

export const JOB_EXTRA_EXAMPLES = [
  '"","","Branding Kit","B.N. Mart Supermarket","Revised Offer Flyer","15-Apr-2026","200","200","INR","1","done","","false","",""',
]
