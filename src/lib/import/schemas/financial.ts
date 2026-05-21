import type { FieldDef } from '../types'
import { normalizeDate, norm } from '../engine'

const VALID_CURRENCIES = ['INR','AED','SAR','USD','QAR','GBP','EUR'] as const

// ── Cashbook entries ─────────────────────────────────────────────────────────
export const CASHBOOK_FIELDS: FieldDef[] = [
  { col: 'id',           db: 'id',           example: '',           notes: 'Leave blank for new rows' },
  { col: 'entry_date',   db: 'entry_date',   example: '2026-05-01', notes: 'DD-MM-YYYY or YYYY-MM-DD', req: true,
    parse: (v) => normalizeDate(v),
    validate: (v) => v && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? 'entry_date must be DD-MM-YYYY' : null },
  { col: 'type',         db: 'type',         example: 'inflow',     notes: 'inflow | outflow', default: 'inflow',
    validate: (v) => !['inflow','outflow'].includes(v) ? 'type must be inflow or outflow' : null },
  { col: 'category',     db: false,          example: 'Client Payment', notes: 'Cash category name',
    aliases: ['category_name'],
    validate: (v, _row, ctx) => v && !ctx.cashCategoryMap[norm(v)] ? { warn: `Category "${v}" not found — will leave blank` } : null },
  { col: 'bank_account', db: false,          example: 'HDFC Current',   notes: 'Bank account name',
    aliases: ['bank_account_name','account'],
    validate: (v, _row, ctx) => v && !ctx.bankAccountMap[norm(v)] ? { warn: `Bank account "${v}" not found — will leave blank` } : null },
  { col: 'amount',       db: 'amount',       example: '5000',       notes: 'Amount in transaction currency', req: true,
    parse: (v) => parseFloat(v) || 0,
    validate: (v) => isNaN(Number(v)) ? 'amount must be a number' : null },
  { col: 'currency',     db: 'currency',     example: 'INR',        notes: VALID_CURRENCIES.join(' | '), default: 'INR' },
  { col: 'amount_inr',   db: 'amount_inr',   example: '',           notes: 'INR equivalent (auto-set to amount when currency = INR)', default: null,
    parse: (v) => v ? parseFloat(v) : null },
  { col: 'description',  db: 'description',  example: 'Monthly payment from Sea Star', notes: 'Description', default: null },
  { col: 'reference',    db: 'reference',    example: '',           notes: 'Reference number or note', default: null },
  { col: 'invoice_number', db: false,        example: 'INV-2503-001', notes: 'Recommended for invoice-linked payments', default: null },
  { col: 'client_name',  db: false,          example: 'Sea Star Logistics', notes: 'For reference only', default: null },
  { col: 'notes',        db: false,          example: 'Paid in full', notes: 'Additional notes', default: null },
]

// ── Invoices ─────────────────────────────────────────────────────────────────
const VALID_INV_STATUSES = ['draft','reviewed','sent','partial','paid','cancelled','bad_debt','overdue'] as const

export const INVOICE_FIELDS: FieldDef[] = [
  { col: 'id',                   db: 'id',                   example: '',           notes: 'Leave blank for new rows' },
  { col: 'invoice_number',       db: 'invoice_number',       example: 'INV-2026-001', notes: 'Unique invoice number', req: true },
  { col: 'client_name_or_code',  db: false,                  example: 'Sea Star Supermarket', notes: 'Client name or code', req: true,
    aliases: ['client'],
    validate: (v, _row, ctx) => v && !ctx.clientMap[norm(v)] ? `Client "${v}" not found` : null },
  { col: 'issue_date',           db: 'issue_date',           example: '2026-05-01', notes: 'DD-MM-YYYY', req: true,
    parse: (v) => normalizeDate(v),
    validate: (v) => v && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? 'issue_date must be DD-MM-YYYY' : null },
  { col: 'due_date',             db: 'due_date',             example: '2026-05-15', notes: 'DD-MM-YYYY (defaults to issue_date + 14 days)', default: null,
    parse: (v) => v ? normalizeDate(v) : null },
  { col: 'billing_period_start', db: 'billing_period_start', example: '2026-05-01', notes: 'DD-MM-YYYY', default: null,
    parse: (v) => v ? normalizeDate(v) : null },
  { col: 'billing_period_end',   db: 'billing_period_end',   example: '2026-05-31', notes: 'DD-MM-YYYY', default: null,
    parse: (v) => v ? normalizeDate(v) : null },
  { col: 'currency',             db: 'currency',             example: 'INR',        notes: VALID_CURRENCIES.join(' | '), default: 'INR' },
  { col: 'subtotal',             db: 'subtotal',             example: '10000',      notes: 'Subtotal before tax/discount', default: 0,
    parse: (v) => parseFloat(v) || 0 },
  { col: 'tax_rate',             db: 'tax_rate',             example: '0',          notes: 'Tax % (e.g. 18 for 18% GST)', default: 0,
    parse: (v) => parseFloat(v) || 0 },
  { col: 'discount_amount',      db: 'discount_amount',      example: '0',          notes: 'Flat discount in invoice currency', default: 0,
    parse: (v) => parseFloat(v) || 0 },
  { col: 'notes',                db: 'notes',                example: '',           notes: 'Internal notes', default: null },
  { col: 'status',               db: 'status',               example: 'draft',      notes: VALID_INV_STATUSES.join(' | '), default: 'draft',
    validate: (v) => v && !VALID_INV_STATUSES.includes(v as any) ? `status "${v}" invalid — use: ${VALID_INV_STATUSES.join(', ')}` : null },
]

// ── Invoice Status Update ─────────────────────────────────────────────────────
const VALID_PAY_METHODS = ['bank_transfer','cheque','cash','upi','online','other',''] as const

export const INVOICE_STATUS_FIELDS: FieldDef[] = [
  { col: 'invoice_number_or_id', db: false,              example: 'INV-2026-001', notes: 'Invoice number or UUID', req: true,
    aliases: ['invoice_number','id'] },
  { col: 'status',               db: 'status',           example: 'paid',         notes: VALID_INV_STATUSES.join(' | '), req: true,
    validate: (v) => v && !VALID_INV_STATUSES.includes(v as any) ? `status "${v}" invalid — use: ${VALID_INV_STATUSES.join(', ')}` : null },
  { col: 'paid_amount',          db: 'paid_amount',      example: '10000',        notes: 'Amount received (required for partial/paid)', default: null,
    parse: (v) => v ? parseFloat(v) : null,
    validate: (v, row) => (row.status === 'partial' || row.status === 'paid') && !v ? { warn: 'paid_amount recommended when status is partial or paid' } : null },
  { col: 'payment_date',         db: 'payment_date',     example: '2026-05-10',   notes: 'DD-MM-YYYY', default: null,
    parse: (v) => v ? normalizeDate(v) : null },
  { col: 'payment_method',       db: 'payment_method',   example: 'bank_transfer',notes: VALID_PAY_METHODS.filter(Boolean).join(' | '), default: '',
    validate: (v) => v && !VALID_PAY_METHODS.includes(v as any) ? { warn: `payment_method "${v}" not standard` } : null },
  { col: 'notes',                db: 'notes',            example: '',             notes: 'Payment notes', default: null },
]

// ── Discount History ──────────────────────────────────────────────────────────
export const DISCOUNT_FIELDS: FieldDef[] = [
  { col: 'invoice_number',      db: false,                 example: 'INV-2026-001', notes: 'Invoice this discount applies to — used as the upsert key', req: true,
    aliases: ['invoice_ref'],
    validate: (_v, _row, _ctx) => null /* validated async in post-process */ },
  { col: 'client_name_or_code', db: false,                 example: 'Sea Star Supermarket', notes: 'Client (optional — inferred from invoice if blank)',
    aliases: ['client'] },
  { col: 'discount_amount',     db: 'discount_amount',     example: '500',  notes: 'Flat discount amount in INR', default: null,
    parse: (v) => v ? parseFloat(v) : null },
  { col: 'discount_percentage', db: 'discount_percentage', example: '',     notes: 'Discount % of invoice total (alternative to flat amount)', default: null,
    parse: (v) => v ? parseFloat(v) : null },
  { col: 'invoice_total',       db: false,                 example: '',     notes: 'Used to compute discount from %; leave blank if providing flat amount', default: null,
    aliases: ['total'] },
  { col: 'reason',              db: 'reason',              example: 'Client loyalty discount', notes: 'Reason for discount', default: null,
    aliases: ['notes'] },
  { col: 'discount_date',       db: 'discount_date',       example: '2026-05-01', notes: 'DD-MM-YYYY', default: null,
    parse: (v) => v ? normalizeDate(v) : null },
]
