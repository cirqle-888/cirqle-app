import type { FieldDef } from '../types'

const VALID_PRICING_TYPES = ['fixed_per_creative','retainer','percentage_of_spend','per_unit','hourly','custom'] as const

export const SERVICE_FIELDS: FieldDef[] = [
  { col: 'id',               db: 'id',               example: '',           notes: 'Leave blank for new rows · REQUIRED in Update mode' },
  { col: 'name',             db: 'name',             example: 'Offer Flyer',notes: 'Service name', req: true },
  { col: 'pricing_type',     db: 'pricing_type',     example: 'fixed_per_creative', notes: VALID_PRICING_TYPES.join(' | '), default: 'fixed_per_creative',
    validate: (v) => v && !VALID_PRICING_TYPES.includes(v as any) ? `pricing_type "${v}" invalid` : null },
  { col: 'description',      db: 'description',      example: 'Promotional offer flyer design', notes: 'Short description', default: null },
  { col: 'display_order',    db: 'display_order',    example: '1',          notes: 'Sort order in lists',     default: 0,
    parse: (v) => parseInt(v) || 0 },
  { col: 'default_price',    db: 'default_price',    example: '',           notes: 'Default price (optional)', default: null,
    parse: (v) => v ? parseFloat(v) : null },
  { col: 'default_currency', db: 'default_currency', example: 'INR',        notes: 'INR | AED | SAR | USD etc.', default: 'INR' },
  // group_names is a computed helper col — pipe-separated group names resolved to group_ids in post-processing
  { col: 'group_names',      db: false,              example: 'Design Group | Variable Group',
    notes: 'Pipe-separated contribution group names (e.g. "Design Group | Variable Group")', default: '' },
  { col: 'is_active',        db: 'is_active',        example: 'true',       notes: 'true / false', default: true,
    parse: (v) => v === '' ? true : v.toLowerCase() === 'true' },
]

export const SERVICE_EXTRA_EXAMPLES = [
  '"","Social Media Management","retainer","Monthly social media package","2","","INR","Design Group","true"',
  '"","Paid Ads","percentage_of_spend","Google/Meta ad management","3","","INR","","true"',
]
