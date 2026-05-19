import type { FieldDef } from '../types'
import { normalizeDate, norm } from '../engine'

/** Static (non-dynamic) fields shared by all contribution sub-modes. */
export const CONTRIB_BASE_FIELDS: FieldDef[] = [
  { col: 'id',            db: 'id',            example: '', notes: 'Leave blank for new rows · REQUIRED in Update mode' },
  { col: 'task_id',       db: false,           example: '', notes: 'Optional · use raw task UUID if available (faster lookup)', default: '' },
  { col: 'task_title',    db: false,           example: 'Social Media Pack Jun', notes: 'Exact task title in DB — import jobs first (ignored if task_id is provided)', req: false },
  { col: 'task_date',     db: false,           example: '2026-05-01', notes: 'DD-MM-YYYY (also accepts YYYY-MM-DD) — used to find the task (with task_title)',
    parse: (v) => normalizeDate(v) },
  { col: 'employee_cqid', db: false,           example: 'CQ001', notes: 'e.g. CQ001', req: true,
    validate: (v, _row, ctx) => {
      if (!v) return null
      if (!ctx.empMap[norm(v)]) return `Employee "${v}" not found`
      return null
    }},
]

export const CONTRIB_SCORE_PCT_FIELDS: FieldDef[] = [
  ...CONTRIB_BASE_FIELDS,
  { col: 'score_percentage', db: 'score_percentage', example: '60', notes: '0–100', req: true,
    parse: (v) => parseFloat(v) || 0,
    validate: (v) => { const n = Number(v); return isNaN(n) || n < 0 || n > 100 ? 'score_percentage must be 0–100' : null }},
  { col: 'earnings_inr',     db: 'earnings',          example: '3000', notes: 'INR amount', default: null,
    aliases: ['earnings'],
    parse: (v) => v ? parseFloat(v) : null,
    validate: (v) => v !== null && isNaN(Number(v)) ? 'earnings_inr must be a number' : null },
]

export const CONTRIB_EARNINGS_ONLY_FIELDS: FieldDef[] = [
  ...CONTRIB_BASE_FIELDS,
  { col: 'earnings_inr', db: 'earnings', example: '3000', notes: 'INR amount', req: true,
    aliases: ['earnings'],
    parse: (v) => parseFloat(v) || 0,
    validate: (v) => isNaN(Number(v)) ? 'earnings_inr must be a number' : null },
]

// param_detail: only base fields are defined in schema; parameter columns are resolved dynamically
export const CONTRIB_PARAM_DETAIL_BASE_FIELDS = CONTRIB_BASE_FIELDS
