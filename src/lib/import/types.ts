// ─── FieldDef ────────────────────────────────────────────────────────────────
// Single source of truth for one CSV column. Everything — template header,
// UI column docs, CSV parser, DB insert — is derived from this definition.
export interface FieldDef<T = any> {
  col: string           // canonical CSV header name (what appears in the template)
  aliases?: string[]    // backward-compat alternate header names accepted on import
  label?: string        // human-readable name; defaults to col
  notes?: string        // shown in the Columns reference table in the UI
  req?: boolean         // mark as required; engine auto-validates

  // DB mapping
  db?: string | false   // DB column name; false = computed/skip on insert; defaults to col

  // Template generation
  example?: string      // value used in the template example row; '' = blank
  omitFromTemplate?: boolean  // skip this col in the CSV template (e.g. computed helpers)

  // Transform: raw CSV string → typed value
  parse?: (raw: string, ctx: ParseContext) => T

  // Validation: return error string (hard), { warn: string } (soft), or null/undefined = OK
  validate?: (value: T, row: Record<string, any>, ctx: ParseContext) => string | { warn: string } | null | undefined

  // Default value when the CSV cell is blank
  default?: T | ((ctx: ParseContext) => T)
}

// ─── ParseContext ─────────────────────────────────────────────────────────────
// Passed to every parse/validate call so fields can resolve lookups.
export interface ParseContext {
  clients:        { id: string; name: string; code: string }[]
  services:       { id: string; name: string }[]
  employees:      { id: string; cqid: string; name: string }[]
  groups:         { id: string; name: string }[]
  parameters:     { id: string; name: string; group_id: string; weight: number; is_master?: boolean; input_type?: string; display_order: number }[]
  bankAccounts:   { id: string; name: string }[]
  cashCategories: { id: string; name: string; type: string }[]
  // Pre-built normalized lookup maps (key = norm(name|code) → id)
  clientMap:       Record<string, string>
  serviceMap:      Record<string, string>
  empMap:          Record<string, string>
  groupMap:        Record<string, string>
  bankAccountMap:  Record<string, string>
  cashCategoryMap: Record<string, string>
}

// ─── ParsedRow ────────────────────────────────────────────────────────────────
export interface ParsedRow {
  _line:    number
  errors:   string[]
  warnings: string[]
  status:   'ok' | 'warn' | 'error'
  [key: string]: any
}
