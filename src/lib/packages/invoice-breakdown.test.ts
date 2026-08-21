import { describe, it, expect } from 'vitest'
import { buildAgreementBreakdowns, type TaskDetail } from './invoice-breakdown'
import type { PackageRow, PackageItemRow } from './types'

const POSTER = 'svc-poster'
const LOGO = 'svc-logo'

const SERVICE_NAMES = new Map([[POSTER, 'Social Media Poster'], [LOGO, 'Logo Design']])

function pkg(over: Partial<PackageRow> = {}): PackageRow {
  return {
    id: 'p1', client_id: 'c1', name: 'Social Media Management',
    billing_type: 'monthly', price: 400, currency: 'AED',
    extra_task_price: 50, start_date: '2026-07-20', end_date: null,
    first_cycle_end: null,
    status: 'active', notes: null, created_by: null,
    created_at: '', updated_at: '', deleted_at: null, ...over,
  }
}

function item(over: Partial<PackageItemRow> = {}): PackageItemRow {
  return {
    id: 'i1', package_id: 'p1', service_id: POSTER, included_quantity: 15,
    display_order: 0, created_at: '', updated_at: '', ...over,
  }
}

function task(over: Partial<TaskDetail> & { id: string }): TaskDetail {
  return {
    service_id: POSTER, task_date: '2026-08-05', status: 'done',
    title: 'A poster', ...over,
  }
}

function build(over: {
  packages?: PackageRow[]
  items?: PackageItemRow[]
  tasks?: TaskDetail[]
  month?: string
  feePackageIds?: Set<string>
} = {}) {
  const packages = over.packages ?? [pkg()]
  const itemsByPackage = new Map([['p1', over.items ?? [item()]]])
  const tasksByPackage = new Map([['p1', over.tasks ?? []]])
  return buildAgreementBreakdowns({
    packages,
    itemsByPackage,
    tasksByPackage,
    serviceNames: SERVICE_NAMES,
    month: over.month ?? '2026-08',
    feePackageIds: over.feePackageIds ?? new Set(['p1']),
  })
}

describe('buildAgreementBreakdowns', () => {
  it('lists the delivered work a fee covered', () => {
    const out = build({
      tasks: [
        task({ id: 't1', title: 'Spiderman Poster', task_date: '2026-08-06' }),
        task({ id: 't2', title: 'A Note of Something New', task_date: '2026-08-10' }),
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0].covered.map(c => c.title))
      .toEqual(['Spiderman Poster', 'A Note of Something New'])
  })

  it('orders covered work by date, so the list reads chronologically', () => {
    const out = build({
      tasks: [
        task({ id: 't2', title: 'Later', task_date: '2026-08-20' }),
        task({ id: 't1', title: 'Earlier', task_date: '2026-08-02' }),
      ],
    })
    expect(out[0].covered.map(c => c.title)).toEqual(['Earlier', 'Later'])
  })

  it('names the service on the allowance line', () => {
    const out = build({ tasks: [task({ id: 't1' })] })
    expect(out[0].allowance).toEqual([
      { serviceId: POSTER, serviceName: 'Social Media Poster', included: 15, delivered: 1, remaining: 14, extra: 0 },
    ])
  })

  it('excludes unfinished work — it has not been delivered yet', () => {
    const out = build({
      tasks: [
        task({ id: 't1', title: 'Done', status: 'done' }),
        task({ id: 't2', title: 'Still open', status: 'in_progress' }),
      ],
    })
    expect(out[0].covered.map(c => c.title)).toEqual(['Done'])
  })

  it('excludes overage — it bills as its own line, so it is not "included"', () => {
    const out = build({
      items: [item({ included_quantity: 1 })],
      tasks: [
        task({ id: 't1', title: 'Covered', task_date: '2026-08-01' }),
        task({ id: 't2', title: 'Extra', task_date: '2026-08-02' }),
      ],
    })
    expect(out[0].covered.map(c => c.title)).toEqual(['Covered'])
    expect(out[0].allowance[0].extra).toBe(1)
  })

  it('reports a fee billed on an earlier invoice, so the reader knows why there is no charge', () => {
    const out = build({
      tasks: [task({ id: 't1' })],
      feePackageIds: new Set<string>(),
    })
    expect(out[0].feeOnThisInvoice).toBe(false)
  })

  it('skips a package out of term — June has nothing to say about August', () => {
    const out = build({
      packages: [pkg({ start_date: '2026-01-01', end_date: '2026-06-30' })],
      tasks: [task({ id: 't1' })],
    })
    expect(out).toEqual([])
  })

  it('skips a package with no covered work AND no fee here — an empty block is noise', () => {
    const out = build({ tasks: [], feePackageIds: new Set<string>() })
    expect(out).toEqual([])
  })

  it('keeps a fee line with no delivered work, so the charge is still explained', () => {
    const out = build({ tasks: [], feePackageIds: new Set(['p1']) })
    expect(out).toHaveLength(1)
    expect(out[0].covered).toEqual([])
  })

  it('carries one allowance across an extended opening cycle', () => {
    // 20 Jul – 31 Aug is ONE cycle. July work counts against the same 15, so
    // August must not show a fresh allowance with the July task missing.
    const out = build({
      packages: [pkg({ first_cycle_end: '2026-08-31' })],
      tasks: [
        task({ id: 't1', title: 'July work', task_date: '2026-07-29' }),
        task({ id: 't2', title: 'August work', task_date: '2026-08-06' }),
      ],
    })
    expect(out[0].covered.map(c => c.title)).toEqual(['July work', 'August work'])
    expect(out[0].allowance[0].delivered).toBe(2)
  })

  it('never carries an amount — covered work is unpriced by construction', () => {
    const out = build({ tasks: [task({ id: 't1' })] })
    expect(Object.keys(out[0].covered[0])).toEqual(
      ['id', 'title', 'taskDate', 'serviceId', 'serviceName', 'status'],
    )
  })
})
