import type { FieldDef, ParseContext, ParsedRow } from './types'

/** Normalize a string for fuzzy matching (lowercase, collapse spaces/underscores) */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '_').replace(/[^a-z0-9_]/g, '').trim()
}

/**
 * Normalize a date string to YYYY-MM-DD.
 *
 * Accepts YYYY-MM-DD, DD-MM-YYYY, DD-MMM-YYYY ('04-Dec-2023'), D/M/YY, and the
 * long human forms a spreadsheet produces ('6 July 2024', '06-July-2024,
 * Saturday'). Anything it cannot read is returned UNCHANGED so the schema's
 * `/^\d{4}-\d{2}-\d{2}$/` validator rejects the row loudly — an unparseable
 * date must never reach the database as NULL.
 *
 * ── Ambiguous dates are DAY-first ───────────────────────────────────────────
 *
 * When both leading numbers are <= 12 ('06/07/2024') the format alone cannot
 * say which is the day. This used to branch on the SEPARATOR — '/' was read as
 * US month-first, '-' as day-first — so the same calendar date imported as two
 * different days depending on punctuation, with no error either way.
 *
 * That contradicted every schema in this folder: task_date, entry_date,
 * issue_date, due_date and joined_date all document 'DD-MM-YYYY', and the
 * business calendar is India (see src/lib/utils/local-date.ts). So '06/07/2024'
 * from a Cirqle sheet means 6 July, and the old code silently stored 7 June.
 *
 * Day-first is now the single rule for the ambiguous case. Unambiguous input is
 * unaffected: '12/25/2023' still reads as December 25 via the day > 12 branch.
 *
 * ── Impossible dates are rejected, not emitted ──────────────────────────────
 *
 * '2026-02-30' and '00-00-0000' previously passed straight through the regex
 * and came out shaped like valid ISO ('2026-02-30', '2000-00-00'), so the
 * validator accepted them and Postgres threw on insert — failing the batch
 * instead of naming the bad row. Each candidate is now round-tripped through a
 * real calendar check before being returned.
 */
export function normalizeDate(s: string): string {
  if (!s) return ''

  // A real calendar date, or null. Rejects month 0/13, day 0, and 30 February.
  const iso = (y: number, m: number, d: number): string | null => {
    if (!(y >= 1000 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null
    const probe = new Date(Date.UTC(y, m - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }

  // Drop a trailing weekday ('06-July-2024, Saturday'), which is how the
  // historical Google Sheet wrote dates and the reason a bulk import once
  // rejected thousands of rows.
  const cleaned = s
    .trim()
    .replace(/[,\s]+(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\.?$/i, '')
    .trim()

  // 1. Already YYYY-MM-DD
  const ymd = cleaned.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/)
  if (ymd) return iso(+ymd[1], +ymd[2], +ymd[3]) ?? s

  // 2. Three numeric parts, day-first unless the numbers say otherwise
  const parts = cleaned.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/)
  if (parts) {
    const p1 = +parts[1]
    const p2 = +parts[2]
    const y = +parts[3] < 100 ? +parts[3] + 2000 : +parts[3]

    // p2 > 12 forces month-first ('12/25/2023'); everything else is day-first,
    // which covers both '25/12/2023' and the ambiguous '06/07/2024'.
    const [day, month] = p2 > 12 ? [p2, p1] : [p1, p2]
    return iso(y, month, day) ?? s
  }

  // 3. Long forms: '04-Dec-2023', '6 July 2024', 'July 6, 2024'.
  //    Parsed in UTC via Date.UTC below rather than read off a local Date, so
  //    the host timezone cannot shift the calendar day (the same trap
  //    local-date.ts exists to avoid).
  const named = cleaned.match(/^(\d{1,2})[\s\-/]+([A-Za-z]{3,})[\s\-/]+(\d{4})$/)
    || cleaned.match(/^([A-Za-z]{3,})[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{4})$/)
  if (named) {
    const dayFirst = /^\d/.test(named[1])
    const dayStr = dayFirst ? named[1] : named[2]
    const monStr = dayFirst ? named[2] : named[1]
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const m = MONTHS.indexOf(monStr.slice(0, 3).toLowerCase()) + 1
    if (m > 0) return iso(+named[3], m, +dayStr) ?? s
  }

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
