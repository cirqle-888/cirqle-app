/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { describe, it, expect } from 'vitest'
import { parseReportRequest, parseScheduleFields, resolveReportScope, isISODate } from './config'

const base = { projectId: 'p1', dateFrom: '2026-10-01', dateTo: '2026-10-07' }

describe('parseReportRequest', () => {
  it('forwards sections (preview/export parity)', () => {
    const r = parseReportRequest({ ...base, sections: { forecast: false } })
    expect(r.ok && r.value.sections).toEqual({ forecast: false })
  })

  it('never returns a client id — the server derives it', () => {
    const r = parseReportRequest({ ...base, clientId: 'someone-else' })
    expect(r.ok).toBe(true)
    expect(r.ok && 'clientId' in r.value).toBe(false)
  })

  it('rejects bad dates, order and ranges', () => {
    expect(parseReportRequest({ ...base, dateFrom: '2026-02-30' }).ok).toBe(false)
    expect(parseReportRequest({ ...base, dateFrom: '2026-10-08' }).ok).toBe(false)
    expect(parseReportRequest({ ...base, dateFrom: '2024-01-01' }).ok).toBe(false)
    expect(parseReportRequest({ ...base, comparisonFrom: '2026-09-01' }).ok).toBe(false)
  })

  it('rejects unknown formats, templates, sections and bad recipients', () => {
    expect(parseReportRequest({ ...base, formats: ['docx'] }).ok).toBe(false)
    expect(parseReportRequest({ ...base, template: 'fancy' }).ok).toBe(false)
    expect(parseReportRequest({ ...base, sections: { nope: true } }).ok).toBe(false)
    expect(parseReportRequest({ ...base, recipients: [{ email: 'not-an-email' }] }).ok).toBe(false)
  })

  it('defaults formats and de-duplicates recipients', () => {
    const r = parseReportRequest({ ...base, recipients: [{ email: 'a@x.com' }, { email: 'A@x.com' }] })
    expect(r.ok && r.value.formats).toEqual(['pdf'])
    expect(r.ok && r.value.recipients).toEqual([{ email: 'a@x.com' }])
  })

  it('isISODate', () => {
    expect(isISODate('2028-02-29')).toBe(true)
    expect(isISODate('2027-02-29')).toBe(false)
  })
})

describe('parseScheduleFields', () => {
  it('fills defaults for create and only present fields for patch', () => {
    const c = parseScheduleFields({})
    expect(c.ok && c.value.frequency).toBe('weekly')
    const p = parseScheduleFields({ delivery_hour: 9 }, true)
    expect(p.ok && p.value).toEqual({ delivery_hour: 9 })
  })
  it('rejects a bad zone or hour', () => {
    expect(parseScheduleFields({ delivery_timezone: 'Nowhere' }).ok).toBe(false)
    expect(parseScheduleFields({ delivery_hour: 25 }).ok).toBe(false)
  })
})

function fakeAdmin(row: any) {
  const q: any = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: row, error: null }) }
  return { from: () => q }
}

describe('resolveReportScope', () => {
  it('takes the client from the campaign row', async () => {
    const r = await resolveReportScope(fakeAdmin({ id: 'p1', client_id: 'c1' }), 'p1')
    expect(r).toEqual({ ok: true, value: { projectId: 'p1', clientId: 'c1' } })
  })
  it('refuses a mismatched client', async () => {
    const r = await resolveReportScope(fakeAdmin({ id: 'p1', client_id: 'c1' }), 'p1', 'c2')
    expect(r.ok).toBe(false)
  })
  it('refuses a missing campaign', async () => {
    expect((await resolveReportScope(fakeAdmin(null), 'p1')).ok).toBe(false)
  })
})
