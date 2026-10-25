/**
 * Report configuration — one validator for preview, generation and schedules.
 *
 * Preview and generate used to build their ReportConfig separately, and the
 * generate route silently dropped `sections`: a report previewed with a
 * section switched off came back with it switched on. Both routes now parse
 * the request body here, so whatever the preview showed is what is exported.
 *
 * The client is NEVER taken from the request. `resolveReportScope` reads it
 * off the campaign row, and a body that names a different client is refused
 * rather than quietly generating a report filed (and branded) under the
 * wrong client.
 */

import type {
  ReportConfig, ReportFormat, ReportRecipient, ReportTemplate, ReportType, ScheduleFrequency, TemplateSections,
} from './types'
import { isValidTimeZone } from './scheduler-utils'

export const REPORT_TYPES: readonly ReportType[] =
  ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom']
export const REPORT_TEMPLATES: readonly ReportTemplate[] =
  ['executive', 'marketing', 'lead_gen', 'ecommerce', 'performance', 'agency', 'daily', 'monthly']
export const REPORT_FORMATS: readonly ReportFormat[] =
  ['pdf', 'xlsx', 'csv', 'image_portrait', 'image_square', 'image_bundle']
export const SECTION_KEYS: readonly (keyof TemplateSections)[] = [
  'executiveSummary', 'kpiScorecard', 'dailyBreakdown', 'campaignHealth',
  'benchmarkComparison', 'forecast', 'aiInsights', 'budgetAnalysis', 'recommendations',
]

/** Longest range a single report may cover. Keeps one request inside the
 *  route's time budget; longer periods belong in a monthly/yearly report. */
export const MAX_RANGE_DAYS = 400
const MAX_RECIPIENTS = 20
/** Most campaigns one client report may combine. */
export const MAX_REPORT_CAMPAIGNS = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
// Deliberately simple: catches typos and pasted junk, not RFC 5322.
const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isISODate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Inclusive day count between two valid ISO dates. */
export function daySpan(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

export function parseRecipients(raw: unknown): ParseResult<ReportRecipient[]> {
  if (raw == null) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false, error: 'Recipients must be a list.' }
  if (raw.length > MAX_RECIPIENTS) return { ok: false, error: `At most ${MAX_RECIPIENTS} recipients.` }
  const seen = new Set<string>()
  const out: ReportRecipient[] = []
  for (const r of raw) {
    const obj = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const email = typeof r === 'string' ? r : obj.email
    if (typeof email !== 'string' || !EMAIL.test(email.trim())) {
      return { ok: false, error: `Invalid recipient email: ${String(email ?? '').slice(0, 80)}` }
    }
    const key = email.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const name = typeof obj.name === 'string' ? obj.name.slice(0, 120) : undefined
    const language = typeof obj.language === 'string' ? obj.language.slice(0, 10) : undefined
    out.push({ email: email.trim(), ...(name ? { name } : {}), ...(language ? { language } : {}) })
  }
  return { ok: true, value: out }
}

export function parseFormats(raw: unknown): ParseResult<ReportFormat[]> {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return { ok: true, value: ['pdf'] }
  if (!Array.isArray(raw)) return { ok: false, error: 'Formats must be a list.' }
  const out: ReportFormat[] = []
  for (const f of raw) {
    if (!REPORT_FORMATS.includes(f as ReportFormat)) return { ok: false, error: `Unsupported format: ${String(f).slice(0, 40)}` }
    if (!out.includes(f as ReportFormat)) out.push(f as ReportFormat)
  }
  return { ok: true, value: out }
}

export function parseSections(raw: unknown): ParseResult<Partial<TemplateSections> | undefined> {
  if (raw == null) return { ok: true, value: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Sections must be an object.' }
  const out: Partial<TemplateSections> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SECTION_KEYS.includes(k as keyof TemplateSections)) return { ok: false, error: `Unknown section: ${k.slice(0, 40)}` }
    if (typeof v !== 'boolean') return { ok: false, error: `Section ${k} must be true or false.` }
    out[k as keyof TemplateSections] = v
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined }
}

/**
 * Parses a preview/generate request body. Everything except the client, the
 * generating employee and the schedule link comes from here — those three are
 * filled in by the server, never by the caller.
 */
export function parseReportRequest(
  body: unknown,
): ParseResult<Omit<ReportConfig, 'clientId' | 'generatedBy' | 'scheduleId'>> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request body.' }
  const b = { ...(body as Record<string, unknown>) }

  // Client report: projectIds (2+). The first id is the primary campaign.
  let projectIds: string[] | undefined
  if (b.projectIds != null) {
    if (!Array.isArray(b.projectIds) || b.projectIds.some(id => typeof id !== 'string' || !UUID.test(id))) {
      return { ok: false, error: 'Invalid campaign selection.' }
    }
    const ids = [...new Set(b.projectIds as string[])]
    if (ids.length === 0) return { ok: false, error: 'Select at least one campaign.' }
    if (ids.length > MAX_REPORT_CAMPAIGNS) return { ok: false, error: `A report can combine at most ${MAX_REPORT_CAMPAIGNS} campaigns.` }
    if (b.projectId == null) b.projectId = ids[0]
    if (ids.length > 1) projectIds = ids.includes(b.projectId as string) ? [b.projectId as string, ...ids.filter(i => i !== b.projectId)] : ids
  }

  if (typeof b.projectId !== 'string' || !b.projectId.trim()) return { ok: false, error: 'Select a campaign.' }
  if (!isISODate(b.dateFrom) || !isISODate(b.dateTo)) return { ok: false, error: 'Select a valid date range.' }
  if (b.dateFrom > b.dateTo) return { ok: false, error: 'The start date is after the end date.' }
  if (daySpan(b.dateFrom, b.dateTo) > MAX_RANGE_DAYS) {
    return { ok: false, error: `A report can cover at most ${MAX_RANGE_DAYS} days.` }
  }

  let comparisonFrom: string | undefined
  let comparisonTo: string | undefined
  if (b.comparisonFrom != null || b.comparisonTo != null) {
    if (!isISODate(b.comparisonFrom) || !isISODate(b.comparisonTo)) {
      return { ok: false, error: 'Select a valid comparison range.' }
    }
    if (b.comparisonFrom > b.comparisonTo) return { ok: false, error: 'The comparison start is after its end.' }
    comparisonFrom = b.comparisonFrom
    comparisonTo = b.comparisonTo
  }

  const reportType = (b.reportType ?? 'custom') as ReportType
  if (!REPORT_TYPES.includes(reportType)) return { ok: false, error: 'Unsupported report type.' }
  const template = (b.template ?? 'performance') as ReportTemplate
  if (!REPORT_TEMPLATES.includes(template)) return { ok: false, error: 'Unsupported template.' }

  const formats = parseFormats(b.formats)
  if (!formats.ok) return formats
  const sections = parseSections(b.sections)
  if (!sections.ok) return sections
  const recipients = parseRecipients(b.recipients)
  if (!recipients.ok) return recipients

  return {
    ok: true,
    value: {
      ...(typeof b.snapshotId === 'string' && /^[0-9a-f-]{36}$/i.test(b.snapshotId) ? { snapshotId: b.snapshotId } : {}),
      ...(typeof b.supersedesId === 'string' && /^[0-9a-f-]{36}$/i.test(b.supersedesId) ? { supersedesId: b.supersedesId } : {}),
      ...(b.allowIncomplete === true ? { allowIncomplete: true } : {}),
      ...(b.language === 'ml' ? { language: 'ml' as const } : {}),
      ...(typeof b.summaryOverride === 'string' && b.summaryOverride.trim() ? { summaryOverride: b.summaryOverride.trim().slice(0, 3000) } : {}),
      projectId: projectIds ? projectIds[0] : b.projectId.trim(),
      ...(projectIds ? { projectIds } : {}),
      reportType,
      template,
      dateFrom: b.dateFrom,
      dateTo: b.dateTo,
      comparisonFrom,
      comparisonTo,
      formats: formats.value,
      sections: sections.value,
      recipients: recipients.value,
    },
  }
}

export interface ReportScope {
  projectId: string
  clientId: string
}

/**
 * Resolves the campaign's owning client from the database. A `claimedClientId`
 * from the request is only checked, never used: a mismatch is refused.
 */
export async function resolveReportScope(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts either Supabase admin client
  admin: { from: (table: string) => any },
  projectId: string,
  claimedClientId?: unknown,
): Promise<ParseResult<ReportScope>> {
  const { data, error } = await admin
    .from('ad_projects')
    .select('id, client_id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) return { ok: false, error: 'Could not load the campaign.' }
  if (!data) return { ok: false, error: 'Campaign not found.' }
  if (!data.client_id) return { ok: false, error: 'This campaign is not linked to a client.' }
  if (claimedClientId != null && claimedClientId !== '' && claimedClientId !== data.client_id) {
    return { ok: false, error: 'The campaign does not belong to the selected client.' }
  }
  return { ok: true, value: { projectId: data.id, clientId: data.client_id } }
}

/**
 * Resolves the client for a client report: every campaign must exist, be
 * linked to a client, and ALL to the same client (Cirqle's own campaigns
 * have no client and so can never join a client report). A claimed client
 * id is only checked, never used.
 */
export async function resolveReportScopeMulti(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts either Supabase admin client
  admin: { from: (table: string) => any },
  projectIds: string[],
  claimedClientId?: unknown,
): Promise<ParseResult<ReportScope & { projectIds: string[] }>> {
  const { data, error } = await admin
    .from('ad_projects')
    .select('id, client_id')
    .in('id', projectIds)
    .is('deleted_at', null)
  if (error) return { ok: false, error: 'Could not load the campaigns.' }
  const rows = (data ?? []) as { id: string; client_id: string | null }[]
  if (rows.length !== projectIds.length) return { ok: false, error: 'One or more campaigns were not found.' }
  if (rows.some(r => !r.client_id)) return { ok: false, error: 'Every campaign in a client report must belong to a client.' }
  const clients = new Set(rows.map(r => r.client_id))
  if (clients.size !== 1) return { ok: false, error: 'All campaigns in a report must belong to the same client.' }
  const clientId = rows[0].client_id as string
  if (claimedClientId != null && claimedClientId !== '' && claimedClientId !== clientId) {
    return { ok: false, error: 'The campaigns do not belong to the selected client.' }
  }
  return { ok: true, value: { projectId: projectIds[0], clientId, projectIds } }
}

/** Single- or multi-campaign scope, whichever the parsed request asks for. */
export async function resolveScopeFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts either Supabase admin client
  admin: { from: (table: string) => any },
  parsed: { projectId: string; projectIds?: string[] },
  claimedClientId?: unknown,
): Promise<ParseResult<ReportScope>> {
  return parsed.projectIds && parsed.projectIds.length > 1
    ? resolveReportScopeMulti(admin, parsed.projectIds, claimedClientId)
    : resolveReportScope(admin, parsed.projectId, claimedClientId)
}

// ─── Schedules (POST and PATCH) ──────────────────────────────────────────────

const FREQUENCIES: readonly ScheduleFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom']

export interface ScheduleFields {
  frequency: ScheduleFrequency
  delivery_hour: number
  delivery_timezone: string
  report_type: ReportType
  template: ReportTemplate
  formats: ReportFormat[]
  recipients: ReportRecipient[]
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

/**
 * Validates the schedule fields present in `body`. With `partial`, absent
 * fields are left out of the result (PATCH); otherwise defaults are filled in.
 */
export function parseScheduleFields(raw: unknown, partial?: false): ParseResult<ScheduleFields>
export function parseScheduleFields(raw: unknown, partial: true): ParseResult<Partial<ScheduleFields>>
export function parseScheduleFields(raw: unknown, partial = false): ParseResult<Partial<ScheduleFields>> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: Partial<ScheduleFields> = {}
  const want = (k: string) => !partial || (k in body && body[k] !== undefined)

  if (want('frequency')) {
    const v = body.frequency ?? 'weekly'
    if (!oneOf(FREQUENCIES, v)) return { ok: false, error: 'Unsupported frequency.' }
    out.frequency = v
  }
  if (want('delivery_hour')) {
    const v = body.delivery_hour ?? 7
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 23) return { ok: false, error: 'Delivery hour must be 0–23.' }
    out.delivery_hour = v
  }
  if (want('delivery_timezone')) {
    const v = body.delivery_timezone ?? 'UTC'
    if (typeof v !== 'string' || !isValidTimeZone(v)) return { ok: false, error: 'Unknown time zone.' }
    out.delivery_timezone = v
  }
  if (want('report_type')) {
    const v = body.report_type ?? 'weekly'
    if (!oneOf(REPORT_TYPES, v)) return { ok: false, error: 'Unsupported report type.' }
    out.report_type = v
  }
  if (want('template')) {
    const v = body.template ?? 'performance'
    if (!oneOf(REPORT_TEMPLATES, v)) return { ok: false, error: 'Unsupported template.' }
    out.template = v
  }
  if (want('formats')) {
    const r = parseFormats(body.formats)
    if (!r.ok) return r
    out.formats = r.value
  }
  if (want('recipients')) {
    const r = parseRecipients(body.recipients)
    if (!r.ok) return r
    out.recipients = r.value
  }
  return { ok: true, value: out }
}
