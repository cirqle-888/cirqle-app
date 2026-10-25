import { describe, it, expect } from 'vitest'
import { composerRange, previousPeriod, presetByKey, REPORT_PRESETS } from './presets'
import { parseReportRequest } from './config'

describe('composerRange', () => {
  it('uses completed days only', () => {
    expect(composerRange('yesterday', '2026-10-25')).toEqual({ dateFrom: '2026-10-24', dateTo: '2026-10-24' })
    expect(composerRange('last7', '2026-10-25')).toEqual({ dateFrom: '2026-10-18', dateTo: '2026-10-24' })
    expect(composerRange('last_month', '2026-03-15')).toEqual({ dateFrom: '2026-02-01', dateTo: '2026-02-28' })
  })
  it('lifetime starts at the campaign start and stays a valid range', () => {
    expect(composerRange('lifetime', '2026-10-25', '2026-10-01')).toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-24' })
    const long = composerRange('lifetime', '2026-10-25', '2020-01-01')
    expect(parseReportRequest({ projectId: 'p', ...long }).ok).toBe(true)
  })
})

describe('previousPeriod', () => {
  it('is the same length, immediately before', () => {
    expect(previousPeriod('2026-10-01', '2026-10-31')).toEqual({ comparisonFrom: '2026-08-31', comparisonTo: '2026-09-30' })
    expect(previousPeriod('2026-10-24', '2026-10-24')).toEqual({ comparisonFrom: '2026-10-23', comparisonTo: '2026-10-23' })
  })
})

describe('presets', () => {
  it('every preset produces a request the shared validator accepts', () => {
    for (const p of REPORT_PRESETS) {
      const r = parseReportRequest({
        projectId: 'p', dateFrom: '2026-09-01', dateTo: '2026-09-30',
        template: p.template, reportType: p.reportType, formats: p.formats, sections: p.sections,
      })
      expect(r.ok, p.key).toBe(true)
    }
  })
  it('falls back to the first preset', () => {
    expect(presetByKey('nope' as never).key).toBe('quick')
  })
})
