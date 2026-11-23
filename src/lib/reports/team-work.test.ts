import { describe, it, expect } from 'vitest'
import {
  buildTeamWorkReport, teamWorkText, teamWorkCardHtml, headline, previousMonth, type TeamWorkInput,
} from './team-work'

const SM = 'dept-social', PRINT = 'dept-print'
const base = (o: Partial<TeamWorkInput> = {}): TeamWorkInput => ({
  month: '2026-11',
  departmentId: SM,
  departmentName: 'Social Media',
  serviceDepartment: new Map([['poster', SM], ['reel', SM], ['brochure', PRINT]]),
  serviceName: new Map([['poster', 'Social Media Poster'], ['reel', 'Reel'], ['brochure', 'Brochure']]),
  clientDepartments: new Map([['seastar', [SM, PRINT]], ['elara', [SM]], ['quiet', [SM]], ['printonly', [PRINT]]]),
  clientName: new Map([['seastar', 'Sea Star'], ['elara', 'Elara'], ['quiet', 'Quiet Co'], ['printonly', 'Print Co']]),
  employeeCqid: new Map([['e4', 'CQID004'], ['e6', 'CQID006']]),
  requests: [],
  tasks: [],
  calendarItems: [],
  calendarDefaultDepartmentId: SM,
  ...o,
})
const req = (o: Partial<TeamWorkInput['requests'][number]>) => ({
  id: Math.random().toString(36), client_id: 'seastar', service_id: 'poster', status: 'completed',
  status_updated_at: '2026-11-10T09:00:00Z', assigned_employee_id: 'e4', promoted_task_id: null, ...o,
})

describe('buildTeamWorkReport', () => {
  it('counts completed requests in the month, by client and service, and credits the person', () => {
    const r = buildTeamWorkReport(base({ requests: [
      req({}), req({}), req({ service_id: 'reel', assigned_employee_id: 'e6' }),
      req({ client_id: 'elara' }),
      req({ status_updated_at: '2026-10-20T09:00:00Z' }),          // last month
      req({ service_id: 'brochure' }),                              // another department
    ] }))
    expect(r.delivered).toBe(4)
    expect(r.lastMonth).toBe(1)
    expect(r.clients.map(c => [c.client, c.delivered])).toEqual([['Sea Star', 3], ['Elara', 1]])
    expect(r.clients[0].byService).toEqual([{ service: 'Social Media Poster', count: 2 }, { service: 'Reel', count: 1 }])
    expect(r.people).toEqual([{ cqid: 'CQID004', delivered: 3 }, { cqid: 'CQID006', delivered: 1 }])
  })

  it('counts a finished task by its quantity, but never twice when it came from a request', () => {
    const r = buildTeamWorkReport(base({
      requests: [req({ promoted_task_id: 't-from-request' })],
      tasks: [
        { id: 't-from-request', client_id: 'seastar', service_id: 'poster', status: 'done', task_date: '2026-11-11', quantity: 1, assignees: ['e4'] },
        { id: 't-direct', client_id: 'seastar', service_id: 'poster', status: 'invoiced', task_date: '2026-11-03', quantity: 9, assignees: ['e6'] },
        { id: 't-pending', client_id: 'seastar', service_id: 'poster', status: 'pending', task_date: '2026-11-04', quantity: 2, assignees: [] },
      ],
    }))
    expect(r.delivered).toBe(10)                     // 1 request + 9 from the direct task
    expect(r.people).toEqual([{ cqid: 'CQID006', delivered: 9 }, { cqid: 'CQID004', delivered: 1 }])
  })

  it('adds the calendar (planned, posted) and what is still open or with the client', () => {
    const r = buildTeamWorkReport(base({
      requests: [req({ status: 'started' }), req({ status: 'delivered', client_id: 'elara' })],
      calendarItems: [
        { client_id: 'seastar', service_id: null, status: 'planned', scheduled_date: '2026-11-20', posted_at: null },
        { client_id: 'seastar', service_id: null, status: 'cancelled', scheduled_date: '2026-11-21', posted_at: null },
        { client_id: 'seastar', service_id: 'poster', status: 'requested', scheduled_date: '2026-11-05', posted_at: '2026-11-06T10:00:00Z' },
        { client_id: 'seastar', service_id: 'brochure', status: 'planned', scheduled_date: '2026-11-05', posted_at: null },
      ],
    }))
    expect(r.planned).toBe(2)
    expect(r.posted).toBe(1)
    expect(r.open).toBe(1)
    expect(r.withClient).toBe(1)
  })

  it('names the department clients with nothing this month, and only those', () => {
    const r = buildTeamWorkReport(base({ requests: [req({}), req({ client_id: 'elara', status: 'submitted' })] }))
    expect(r.quietClients).toEqual(['Quiet Co'])     // Print Co is not a Social Media client
  })
})

describe('sharing', () => {
  const r = buildTeamWorkReport(base({ requests: [
    req({}), req({}), req({ status_updated_at: '2026-10-02T09:00:00Z' }),
  ] }))

  it('gives an encouraging headline with the change on last month', () => {
    expect(headline(r)).toBe('2 pieces delivered for 1 client — 1 more than October 🚀')
  })

  it('writes a WhatsApp message with the totals, clients, quiet clients and team', () => {
    const text = teamWorkText(r)
    expect(text).toContain('*Social Media — November 2026*')
    expect(text).toContain('• Sea Star — 2 done')
    expect(text).toContain('*Nothing yet this month (2)*')
    expect(text).toContain('CQID004 2')
  })

  it('carries no money and escapes names in the image', () => {
    const html = teamWorkCardHtml(buildTeamWorkReport(base({
      clientName: new Map([['seastar', '<Sea & Star>']]), requests: [req({})],
    })))
    expect(html).toContain('&lt;Sea &amp; Star&gt;')
    expect(html).not.toMatch(/₹|INR|amount/i)
  })

  it('steps back across a year boundary', () => {
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(previousMonth('2026-11')).toBe('2026-10')
  })
})
