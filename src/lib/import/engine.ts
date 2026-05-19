import type { FieldDef, ParseContext, ParsedRow } from './types'

/** Normalize a string for fuzzy matching (lowercase, collapse spaces/underscores) */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '_').replace(/[^a-z0-9_]/g, '').trim()
}

/** Normalize a date string to YYYY-MM-DD. Accepts DD-MM-YYYY or YYYY-MM-DD. */
export function normalizeDate(s: string): string {
  if (!s) return ''
  const ddmm = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/)
  if (ddmm) return `${ddmm[3]}-${ddmm[2].padStart(2,'0')}-${ddmm[1].padStart(2,'0')}`
  const yyyymm = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/)
  if (yyyymm) return `${yyyymm[1]}-${yyyymm[2].padStart(2,'0')}-${yyyymm[3].padStart(2,'0')}`
  return s
}

/** Build the CSV header line from a FieldDef array. */
export function buildHeader(fields: FieldDef[]): string {
  return fields.filter(f => !f.omitFromTemplate).map(f => f.col).join(',')
}

/** Build one example CSV row. Each field uses its `example` value (or blank). */
export function buildExampleRow(fields: FieldDef[]): string {
  return fields
    .filter(f => !f.omitFromTemplate)
    .map(f => `"${(f.example ?? '').replace(/"/g, '""')}"`)
    .join(',')
}

/** Column definitions for the import UI table — derived from FieldDef[]. */
export function buildColumnDefs(fields: FieldDef[]): { col: string; req: boolean; notes: string }[] {
  return fields
    .filter(f => !f.omitFromTemplate)
    .map(f => ({ col: f.col, req: !!f.req, notes: f.notes ?? '' }))
}

/**
 * Build a header-to-index map that supports canonical names and aliases.
 * Returns { canonicalColName → csvColumnIndex }.
 */
function buildHeaderMap(fields: FieldDef[], csvHeaders: string[]): Record<string, number> {
  const normHeaders = csvHeaders.map(h => norm(h))
  const map: Record<string, number> = {}
  for (const field of fields) {
    if (map[field.col] !== undefined) continue
    const allNames = [field.col, ...(field.aliases ?? [])]
    for (const name of allNames) {
      const ni = normHeaders.indexOf(norm(name))
      if (ni !== -1) { map[field.col] = ni; break }
    }
  }
  return map
}

/**
 * Parse a single CSV data row using a FieldDef array.
 * Handles: alias resolution, default values, parse transforms, required checks,
 * and custom per-field validation.
 */
export function parseRowFromSchema(
  fields: FieldDef[],
  rawCells: string[],
  csvHeaders: string[],
  lineNumber: number,
  ctx: ParseContext,
): ParsedRow {
  const headerMap = buildHeaderMap(fields, csvHeaders)
  const get = (col: string): string => {
    const i = headerMap[col]
    return i !== undefined ? (rawCells[i] ?? '').trim() : ''
  }

  const row: ParsedRow = { _line: lineNumber, errors: [], warnings: [], status: 'ok' }

  for (const field of fields) {
    const raw = get(field.col)
    let value: any

    if (raw === '' && field.default !== undefined) {
      value = typeof field.default === 'function' ? (field.default as (ctx: ParseContext) => any)(ctx) : field.default
    } else if (raw !== '' && field.parse) {
      value = field.parse(raw, ctx)
    } else {
      value = raw
    }

    if (field.req && (value === '' || value === null || value === undefined)) {
      row.errors.push(`${field.col} is required`)
    }

    if (field.validate && value !== '' && value !== null && value !== undefined) {
      const result = field.validate(value, row, ctx)
      if (result) {
        if (typeof result === 'string') row.errors.push(result)
        else row.warnings.push(result.warn)
      }
    }

    row[field.col] = value
  }

  row.status = row.errors.length > 0 ? 'error' : row.warnings.length > 0 ? 'warn' : 'ok'
  return row
}

/**
 * Build a DB insert/update record from a parsed row.
 * Fields with db: false are skipped (they are computed helpers).
 * Fields with db: 'some_col' use the db column name instead of the CSV col name.
 */
export function buildInsertRecord(fields: FieldDef[], parsedRow: ParsedRow): Record<string, any> {
  const record: Record<string, any> = {}
  for (const field of fields) {
    if (field.db === false) continue
    const dbCol = field.db ?? field.col
    if (parsedRow[field.col] !== undefined) record[dbCol] = parsedRow[field.col]
  }
  return record
}

/**
 * Build the CSV template string (header + example row).
 * Appends a reference section listing valid values from context.
 */
export function buildTemplate(
  fields: FieldDef[],
  extraExampleRows?: string[],   // additional example rows beyond the first
  refLines?: string[],           // valid-values reference section
): string {
  const header = buildHeader(fields)
  const example = buildExampleRow(fields)
  const extra = extraExampleRows?.length ? '\n' + extraExampleRows.join('\n') : ''
  const ref = refLines?.length
    ? '\n\n# ── VALID VALUES — delete these comment rows before importing ───────────\n' + refLines.join('\n')
    : ''
  return header + '\n' + example + extra + ref
}
