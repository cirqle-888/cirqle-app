import type { FieldDef } from '../types'
import { norm } from '../engine'

const VALID_INPUT_TYPES = ['percentage','count'] as const
const VALID_CURRENCIES  = ['INR','AED','SAR','USD','QAR','GBP','EUR'] as const

export const GROUP_FIELDS: FieldDef[] = [
  { col: 'id',            db: 'id',            example: '',              notes: 'Leave blank for new rows · REQUIRED in Update mode' },
  { col: 'name',          db: 'name',          example: 'Design Group',  notes: 'Group name', req: true },
  { col: 'weight',        db: 'weight',        example: '50',            notes: 'Relative weight (e.g. 50)', req: true,
    parse: (v) => parseFloat(v) || 0,
    validate: (v) => isNaN(Number(v)) ? 'weight must be a number' : null },
  { col: 'description',   db: 'description',   example: 'Core design work parameters', notes: 'Short description', default: null },
  { col: 'display_order', db: 'display_order', example: '1',             notes: 'Sort order', default: 0, parse: (v) => parseInt(v) || 0 },
  { col: 'is_active',     db: 'is_active',     example: 'true',          notes: 'true / false', default: true,
    parse: (v) => v === '' ? true : v.toLowerCase() === 'true' },
]

export const PARAMETER_FIELDS: FieldDef[] = [
  { col: 'id',            db: 'id',            example: '',               notes: 'Leave blank for new rows · REQUIRED in Update mode' },
  { col: 'group_name',    db: false,           example: 'Design Group',   notes: 'Group this parameter belongs to (must exist)', req: true,
    validate: (v, _row, ctx) => v && !ctx.groupMap[norm(v)] ? `Group "${v}" not found — create the group first` : null },
  { col: 'name',          db: 'name',          example: 'Design',         notes: 'Parameter name', req: true },
  { col: 'is_master',     db: 'is_master',     example: 'TRUE',           notes: 'TRUE / FALSE — master parameters drive the main score', default: false,
    parse: (v) => ['true','TRUE','1','yes'].includes(v) },
  { col: 'weight',        db: 'weight',        example: '1',              notes: 'Numeric weight relative to other parameters in group', default: 1,
    parse: (v) => parseFloat(v) || 1 },
  { col: 'description',   db: 'description',   example: 'Main design score (0–100%)', notes: 'Short description', default: null },
  { col: 'display_order', db: 'display_order', example: '1',              notes: 'Sort order within group', default: 0,
    parse: (v) => parseInt(v) || 0 },
  { col: 'input_type',    db: 'input_type',    example: 'percentage',     notes: VALID_INPUT_TYPES.join(' | '), default: 'percentage',
    validate: (v) => v && !VALID_INPUT_TYPES.includes(v as any) ? `input_type "${v}" invalid` : null },
  { col: 'is_active',     db: 'is_active',     example: 'true',           notes: 'true / false', default: true,
    parse: (v) => v === '' ? true : v.toLowerCase() === 'true' },
]

export const TOOL_FIELDS: FieldDef[] = [
  { col: 'id',               db: 'id',               example: '',         notes: 'Leave blank for new rows · REQUIRED in Update mode' },
  { col: 'name',             db: 'name',             example: 'Ideogram', notes: 'Tool name', req: true },
  { col: 'fixed_percentage', db: 'fixed_percentage', example: '10',       notes: 'Percentage deducted from contribution earnings (0–100)', req: true,
    parse: (v) => parseFloat(v) || 0,
    validate: (v) => isNaN(Number(v)) ? 'fixed_percentage must be a number' : null },
  { col: 'group_name',       db: false,              example: 'Design Group', notes: 'Contribution group this tool applies to (optional)', default: '',
    validate: (v, _row, ctx) => v && !ctx.groupMap[norm(v)] ? `Group "${v}" not found — tool saved without group` : null },
  { col: 'description',      db: 'description',      example: 'AI image generation tool', notes: 'Short description', default: null },
  { col: 'is_active',        db: 'is_active',        example: 'true',     notes: 'true / false', default: true,
    parse: (v) => v === '' ? true : v.toLowerCase() === 'true' },
]

export const PRICING_MATRIX_FIELDS: FieldDef[] = [
  { col: 'id',                    db: 'id',                    example: '',                    notes: 'Leave blank for new rows' },
  { col: 'client_name_or_code',   db: false,                   example: 'Sea Star Supermarket',notes: 'Client name or code — must match existing client', req: true,
    validate: (v, _row, ctx) => {
      if (!v) return null
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
      if (!isUuid && !ctx.clientMap[norm(v)]) return `Client "${v}" not found`
      return null
    }},
  { col: 'service_name',          db: false,                   example: 'Offer Flyer',         notes: 'Service name — must match exactly', req: true,
    validate: (v, _row, ctx) => {
      if (!v) return null
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
      if (!isUuid && !ctx.serviceMap[norm(v)]) return `Service "${v}" not found`
      return null
    }},
  { col: 'price',                 db: 'price',                 example: '250',                 notes: 'Fixed price per creative (blank if using percentage)', default: null,
    parse: (v) => v ? parseFloat(v) : null,
    validate: (v) => v !== null && isNaN(Number(v)) ? 'price must be a number' : null },
  { col: 'percentage_rate',       db: 'percentage_rate',       example: '',                    notes: '% of spend (blank if using fixed price)', default: null,
    parse: (v) => v ? parseFloat(v) : null },
  { col: 'commission_percentage', db: 'commission_percentage', example: '75',                  notes: '% of billing that goes to contribution pool', req: true,
    parse: (v) => parseFloat(v) || 0,
    validate: (v) => isNaN(Number(v)) ? 'commission_percentage must be a number' : null },
  { col: 'currency',              db: 'currency',              example: 'INR',                 notes: VALID_CURRENCIES.join(' | '), default: 'INR',
    validate: (v) => v && !VALID_CURRENCIES.includes(v.toUpperCase() as any) ? { warn: `Currency "${v}" not recognised — defaulting to INR` } : null },
  { col: 'is_active',             db: 'is_active',             example: 'true',                notes: 'true / false', default: true,
    parse: (v) => v === '' ? true : v.toLowerCase() === 'true' },
]
