import { describe, it, expect } from 'vitest'
import { pickAssignee, type AssignHistoryRow } from './assign-rules'

const h = (employee_id: string, service_id: string | null = 'poster', client_id = 'sea'): AssignHistoryRow => ({ client_id, service_id, employee_id })
const active = new Set(['rahul', 'anu', 'joe'])
const req = { id: 'r', client_id: 'sea', service_id: 'poster' }

describe('who gets a new request', () => {
  it('picks the person who clearly does this client’s work', () => {
    expect(pickAssignee(req, [h('rahul'), h('rahul'), h('anu', 'reel')], active)).toEqual({ employeeId: 'rahul', share: 0.86, jobs: 2 })
  })
  it('weighs the same service above other work for the client', () => {
    const r = pickAssignee(req, [h('anu', 'reel'), h('anu', 'reel'), h('anu', 'reel'), h('rahul'), h('rahul')], active)
    expect(r?.employeeId).toBe('rahul')
  })
  it('leaves split teams, single jobs, new clients and former staff for a person', () => {
    expect(pickAssignee(req, [h('rahul'), h('anu'), h('joe')], active)).toBeNull()
    expect(pickAssignee(req, [h('rahul')], active)).toBeNull()
    expect(pickAssignee(req, [h('rahul', 'poster', 'other'), h('rahul', 'poster', 'other')], active)).toBeNull()
    expect(pickAssignee(req, [h('gone'), h('gone')], active)).toBeNull()
    expect(pickAssignee({ ...req, client_id: null }, [h('rahul'), h('rahul')], active)).toBeNull()
  })
})
