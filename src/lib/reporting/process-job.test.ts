/* eslint-disable @typescript-eslint/no-explicit-any -- test query builder */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ claim: vi.fn(), run: vi.fn(), complete: vi.fn(), fail: vi.fn(), heartbeat: vi.fn(), filters: [] as any[] }))
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({ from: () => {
  const chain: any = { update: () => chain, select: () => chain, maybeSingle: mock.claim }
  for (const method of ['eq', 'in', 'lte']) chain[method] = (...args: any[]) => { mock.filters.push([method, ...args]); return chain }
  return chain
} }) }))
vi.mock('@/lib/jobs/engine', () => ({ completeJob: mock.complete, failJob: mock.fail, heartbeatJob: mock.heartbeat }))
vi.mock('@/lib/advertising/workers/reports', () => ({ generateReportWorker: mock.run }))
import { processReportJob } from './process-job'
beforeEach(() => { vi.clearAllMocks(); mock.filters = [] })
describe('report worker wake-up', () => {
  it('does not run an unclaimed or already running job', async () => {
    mock.claim.mockResolvedValue({ data: null, error: null })
    await processReportJob('job1')
    expect(mock.run).not.toHaveBeenCalled()
    expect(mock.filters).toContainEqual(['eq', 'id', 'job1'])
    expect(mock.filters).toContainEqual(['eq', 'job_type', 'advertising_generate_report'])
    expect(mock.filters).toContainEqual(['in', 'status', ['pending', 'queued']])
  })
  it('completes the claimed job', async () => {
    const job = { id: 'job1' }
    mock.claim.mockResolvedValue({ data: job }); mock.run.mockResolvedValue({ status: 'partial' })
    await processReportJob('job1')
    expect(mock.complete).toHaveBeenCalledWith(job, { status: 'partial' })
    expect(mock.fail).not.toHaveBeenCalled()
  })
  it('records handler failure for retry', async () => {
    const job = { id: 'job1' }
    mock.claim.mockResolvedValue({ data: job }); mock.run.mockRejectedValue(new Error('Failed'))
    await processReportJob('job1')
    expect(mock.fail).toHaveBeenCalledWith(job, 'Failed')
    expect(mock.complete).not.toHaveBeenCalled()
  })
})
