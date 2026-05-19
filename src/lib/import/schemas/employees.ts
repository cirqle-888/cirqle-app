import type { FieldDef, ParseContext } from '../types'
import { normalizeDate, norm } from '../engine'

const VALID_ROLES     = ['super_admin','accounts','team_lead','employee','view_only'] as const
const VALID_SAL_TYPES = ['fixed','commission_only','fixed_plus_commission','pure_commission','base_plus_commission','fixed_plus_bonus','hourly'] as const

export const EMPLOYEE_FIELDS: FieldDef[] = [
  { col: 'id',                 db: 'id',                 example: '',          notes: 'Leave blank for new rows · REQUIRED in Update mode (use Export to get current ids)' },
  { col: 'cqid',               db: 'cqid',               example: 'CQ001',     notes: 'Unique employee ID (e.g. CQ001)',                    req: true },
  { col: 'name',               db: 'name',               example: 'John Smith',notes: 'Full name',                                          req: true },
  { col: 'email',              db: 'email',              example: 'john@cirqle.in', notes: 'Work email', req: true,
    validate: (v) => v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'email format invalid' : null },
  { col: 'phone',              db: 'phone',              example: '9876543210', notes: 'Phone number',                                      default: null },
  { col: 'role',               db: 'role',               example: 'employee',  notes: VALID_ROLES.join(' | '),                              default: 'employee',
    validate: (v) => v && !VALID_ROLES.includes(v as any) ? `role "${v}" invalid — use: ${VALID_ROLES.join(', ')}` : null },
  { col: 'salary_type',        db: 'salary_type',        example: 'fixed',     notes: VALID_SAL_TYPES.join(' | '),                         default: 'fixed',
    validate: (v) => v && !VALID_SAL_TYPES.includes(v as any) ? `salary_type "${v}" invalid` : null },
  { col: 'base_salary',        db: 'base_salary',        example: '25000',     notes: 'Monthly base amount in INR',                        default: 0,
    parse: (v) => parseFloat(v) || 0 },
  { col: 'performance_rating', db: 'performance_rating', example: '80',        notes: '0–100',                                             default: 70,
    parse: (v) => parseFloat(v) || 70 },
  { col: 'joined_date',        db: 'joined_date',        example: '2024-01-15',notes: 'DD-MM-YYYY or YYYY-MM-DD',                          default: null,
    parse: (v) => normalizeDate(v) || null,
    validate: (v) => v && !/^\d{4}-\d{2}-\d{2}$/.test(v) ? 'joined_date must be DD-MM-YYYY (e.g. 18-05-2026)' : null },
  { col: 'is_active',          db: 'is_active',          example: 'true',      notes: 'true / false',                                      default: true,
    parse: (v) => v === '' ? true : v.toLowerCase() === 'true' },
]

export const EMPLOYEE_EXTRA_EXAMPLES = [
  '"","CQ002","Jane Doe","jane@cirqle.in","9876543211","team_lead","fixed_plus_commission","30000","85","2024-03-01","true"',
]
