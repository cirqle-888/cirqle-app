import { describe, it, expect } from 'vitest'
import {
  checkPeriod, countDeliveries, deliveryFindings, payReminders, postsWithoutTask, resolveClientId,
  tasksWithoutContributors, type PcTask,
} from './pay-check-rules'

const task = (over: Partial<PcTask>): PcTask => ({
  id: 't', task_number: 1, title: 'Poster', client_id: 'sea', task_date: '2026-11-18', status: 'done',
  contributors: ['rahul'], assignees: ['rahul'], ...over,
})
const nov = { from: '2026-11-01', to: '2026-11-21', month: '2026-11-01' }

describe('which month is checked', () => {
  it('pays last month in the first week, then follows this month', () => {
    expect(checkPeriod('2026-12-05')).toEqual({ from: '2026-11-01', to: '2026-11-30', month: '2026-11-01' })
    expect(checkPeriod('2026-11-21')).toEqual(nov)
    expect(checkPeriod('2027-01-02').month).toBe('2026-12-01')
  })
})

describe('finished work with nobody credited', () => {
  it('lists done, delivered and invoiced tasks in the period only', () => {
    const r = tasksWithoutContributors([
      task({ id: 'a', contributors: [] }),
      task({ id: 'b', contributors: [], status: 'pending' }),
      task({ id: 'c', contributors: [], task_date: '2026-10-30' }),
      task({ id: 'd' }),
      task({ id: 'e', contributors: [], status: 'invoiced', task_date: '2026-11-02' }),
    ], nov)
    expect(r.map(t => t.id)).toEqual(['e', 'a'])
  })
})

describe('designs sent in WhatsApp groups', () => {
  it('flags a sender not credited when the nearby task credits someone else', () => {
    const r = deliveryFindings([task({ id: 'poster', contributors: ['anu'] })], [{ client_id: 'sea', employee_id: 'rahul', day: '2026-11-19', count: 2 }], nov)
    expect(r.uncredited).toEqual([{ client_id: 'sea', employee_id: 'rahul', day: '2026-11-19', count: 2, taskIds: ['poster'] }])
    expect(r.noTask).toEqual([])
  })
  it('stays quiet when the sender is credited, or nobody is credited yet', () => {
    expect(deliveryFindings([task({})], [{ client_id: 'sea', employee_id: 'rahul', day: '2026-11-18', count: 1 }], nov).uncredited).toEqual([])
    expect(deliveryFindings([task({ contributors: [] })], [{ client_id: 'sea', employee_id: 'anu', day: '2026-11-18', count: 1 }], nov).uncredited).toEqual([])
  })
  it('reports designs with no task within three days before or one after', () => {
    const r = deliveryFindings([task({ task_date: '2026-11-10' })], [
      { client_id: 'sea', employee_id: 'rahul', day: '2026-11-15', count: 2 },
      { client_id: 'sea', employee_id: 'anu', day: '2026-11-15', count: 1 },
      { client_id: 'sea', employee_id: 'rahul', day: '2026-11-11', count: 1 },
      { client_id: 'sea', employee_id: 'rahul', day: '2026-11-09', count: 1 },
    ], nov)
    expect(r.noTask).toEqual([{ client_id: 'sea', day: '2026-11-15', count: 3, senders: ['rahul', 'anu'] }])
  })
  it('counts files per client, person and day, ignoring unknown numbers and chats', () => {
    expect(countDeliveries([
      { client_id: 'sea', employee_id: 'rahul', day: '2026-11-18' },
      { client_id: 'sea', employee_id: 'rahul', day: '2026-11-18' },
      { client_id: null, employee_id: 'rahul', day: '2026-11-18' },
      { client_id: 'sea', employee_id: null, day: '2026-11-18' },
    ])).toEqual([{ client_id: 'sea', employee_id: 'rahul', day: '2026-11-18', count: 2 }])
  })
})

describe('live posts', () => {
  it('flags a post with no task for that client in the week before', () => {
    const tasks = [task({ task_date: '2026-11-12' })]
    const r = postsWithoutTask(tasks, [
      { client_id: 'sea', day: '2026-11-18', permalink: 'a', kind: 'FEED' },
      { client_id: 'sea', day: '2026-11-20', permalink: 'b', kind: 'REELS' },
      { client_id: 'other', day: '2026-11-18', permalink: 'c', kind: 'FEED' },
    ], nov)
    expect(r.map(p => p.permalink)).toEqual(['c', 'b'])
  })
})

describe('group names to clients', () => {
  const clients = [{ id: '1', name: 'Sea Star Catering and Hotel' }, { id: '2', name: 'Sea Star Supermarket' }, { id: '3', name: 'Elara' }]
  it('matches exact names first, then a single partial match', () => {
    expect(resolveClientId('sea star supermarket', clients)).toBe('2')
    expect(resolveClientId('Elara Bahrain', clients)).toBe('3')
    expect(resolveClientId('Sea Star', clients)).toBeNull()
    expect(resolveClientId('', clients)).toBeNull()
  })
})

describe('pay reminders', () => {
  const emps = [{ id: 'a', name: 'Anu', salary_day: 5 }, { id: 'r', name: 'Rahul', salary_day: 10 }, { id: 'p', name: 'Paid', salary_day: 5 }]
  const pay = [
    { employee_id: 'a', status: 'pending', net_salary: 18000 },
    { employee_id: 'r', status: 'revealed', net_salary: 22000 },
    { employee_id: 'p', status: 'paid', net_salary: 15000 },
  ]
  it('reminds from three days before the salary day and marks late ones', () => {
    expect(payReminders(emps, pay, '2026-12-01')).toEqual([])
    expect(payReminders(emps, pay, '2026-12-02').map(p => p.name)).toEqual(['Anu'])
    const r = payReminders(emps, pay, '2026-12-08')
    expect(r.map(p => [p.name, p.late])).toEqual([['Anu', true], ['Rahul', false]])
  })
  it('clamps the salary day to the month', () => {
    expect(payReminders([{ id: 'a', name: 'Anu', salary_day: 31 }], pay, '2027-02-28')[0].payDate).toBe('2027-02-28')
  })
})
