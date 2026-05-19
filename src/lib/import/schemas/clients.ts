import type { FieldDef } from '../types'
import { normalizeDate } from '../engine'

const VALID_CURRENCIES   = ['INR','AED','SAR','USD','QAR','GBP','EUR'] as const
const VALID_BILL_CYCLES  = ['monthly','weekly','daily','none'] as const

export const CLIENT_FIELDS: FieldDef[] = [
  { col: 'id',               db: 'id',               example: '',           notes: 'Leave blank for new rows · REQUIRED in Update mode' },
  { col: 'code',             db: 'code',             example: 'SSM001',     notes: 'Short unique code (used in templates & reports)', req: true },
  { col: 'name',             db: 'name',             example: 'Sea Star Supermarket', notes: 'Full client name', req: true },
  { col: 'contact_name',     db: 'contact_name',     example: 'Ravi Kumar', notes: 'Primary contact person',   default: null },
  { col: 'phone',            db: 'phone',            example: '9876540001', notes: 'Contact phone',            default: null },
  { col: 'email',            db: 'email',            example: 'ravi@seastar.in', notes: 'Contact email',      default: null },
  { col: 'address',          db: 'address',          example: 'MG Road, Kochi', notes: 'Billing address',     default: null },
  { col: 'gstin',            db: 'gstin',            example: '',           notes: 'GST number (optional)',    default: null },
  { col: 'default_currency', db: 'default_currency', example: 'INR',        notes: VALID_CURRENCIES.join(' | '), default: 'INR',
    validate: (v) => v && !VALID_CURRENCIES.includes(v.toUpperCase() as any) ? `currency "${v}" not recognised` : null,
    parse: (v) => v.toUpperCase() },
  { col: 'billing_cycle',    db: 'billing_cycle',    example: 'monthly',    notes: VALID_BILL_CYCLES.join(' | '), default: 'monthly',
    validate: (v) => v && !VALID_BILL_CYCLES.includes(v as any) ? `billing_cycle "${v}" invalid — use ${VALID_BILL_CYCLES.join('/')}` : null },
  { col: 'billing_day',      db: 'billing_day',      example: '1',          notes: 'Day of month (1–28)',      default: 1,
    parse: (v) => parseInt(v) || 1 },
  { col: 'is_active',        db: 'is_active',        example: 'true',       notes: 'true / false',            default: true,
    parse: (v) => v === '' ? true : v.toLowerCase() === 'true' },
]

export const CLIENT_EXTRA_EXAMPLES = [
  '"","BNM001","B.N. Mart Supermarket","Anita Nair","9876540002","","Anna Nagar, Chennai","","INR","monthly","1","true"',
]
