/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory database boundary */
import { describe, it, expect, vi, beforeEach } from 'vitest'
const state = vi.hoisted(() => ({ row: {} as any, updates: [] as any[], saveFails: false }))
const render = vi.hoisted(() => vi.fn())
const pdf = vi.hoisted(() => vi.fn())
const xlsx = vi.hoisted(() => vi.fn())
const send = vi.hoisted(() => vi.fn())
const upload = vi.hoisted(() => vi.fn())
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({
  rpc,
  from: () => ({
    insert: () => Promise.resolve({ error: null }),
    select: () => ({ eq: () => ({ single: async () => ({ data: structuredClone(state.row), error: null }) }) }),
    update: (row: any) => ({ eq: async () => {
      if (state.saveFails) return { error: { message: 'offline' } }
      state.updates.push(structuredClone(row)); Object.assign(state.row, structuredClone(row)); return { error: null }
    } }),
  }),
}) }))
vi.mock('./sync-before-report', () => ({ syncBeforeReport: vi.fn() }))
vi.mock('./snapshot', () => ({ snapshotProblem: () => null }))
vi.mock('./render-engine', () => ({ buildRenderData: render }))
vi.mock('./exporters/pdf', () => ({ generatePDF: pdf }))
vi.mock('./exporters/excel', () => ({ generateExcel: xlsx }))
vi.mock('./exporters/csv', () => ({ generateCSV: vi.fn() }))
vi.mock('./exporters/image', () => ({ generateImagePortrait: vi.fn(), generateImageSquare: vi.fn() }))
vi.mock('./delivery-engine', () => ({ uploadExport: upload, sendReportEmail: send, signDownloadUrl: async (key: string) => `https://files/${key}` }))
import { generateReport, enqueueReportGeneration } from './orchestrator'
const config: any = { reportId: 'r', projectId: 'p', clientId: 'c', reportType: 'custom', template: 'daily', dateFrom: '2026-10-01', dateTo: '2026-10-07', formats: ['pdf', 'xlsx'], recipients: [{ email: 'fixture@example.test' }] }

beforeEach(() => {
  vi.clearAllMocks(); state.saveFails = false; state.updates = []
  state.row = { id: 'r', project_id: 'p', client_id: 'c', config, review_status: 'approved', status: 'pending', export_results: [], delivery_results: [] }
  render.mockResolvedValue({ ai: { summary: 'Saved narrative' } })
  pdf.mockResolvedValue(Buffer.from('pdf')); xlsx.mockResolvedValue(Buffer.from('xlsx'))
  upload.mockImplementation(async (_id: string, format: string) => ({ format, storageKey: `reports/r/${format}/file`, publicUrl: `https://files/${format}`, sizeBytes: 1 }))
  send.mockResolvedValue({ accepted: [{ email: 'fixture@example.test', providerId: 'message1' }], failed: [] })
})
describe('stable report runs', () => {
  it('all exports failing produces failed and never emails', async () => {
    pdf.mockRejectedValue(new Error('bad pdf')); xlsx.mockRejectedValue(new Error('bad xlsx'))
    const result = await generateReport(config)
    expect(result.status).toBe('failed'); expect(result.failedFormats).toHaveLength(2)
    expect(send).not.toHaveBeenCalled(); expect(state.row.status).toBe('failed')
  })
  it('partial is explicit, downloads survive, and incomplete reports are not sent', async () => {
    xlsx.mockRejectedValue(new Error('bad xlsx'))
    const result = await generateReport(config)
    expect(result.status).toBe('partial'); expect(state.row.pdf_url).toBeTruthy()
    expect(state.row.export_failures[0].format).toBe('xlsx'); expect(send).not.toHaveBeenCalled()
  })
  it('retry reuses snapshot and successful exports, keeping one report ID', async () => {
    xlsx.mockRejectedValueOnce(new Error('bad xlsx'))
    await generateReport(config)
    const result = await generateReport(config)
    expect(result.reportId).toBe('r'); expect(result.status).toBe('ready')
    expect(render).toHaveBeenCalledTimes(1); expect(pdf).toHaveBeenCalledTimes(1)
    expect(xlsx).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][3]).toMatch(/^report-/)
  })
  it('persisted ready run does not export or deliver twice', async () => {
    await generateReport(config); await generateReport(config)
    expect(pdf).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1)
  })
  it.each(['accepted', 'sending', 'failed'])('does not automatically resend a saved %s email attempt', async status => {
    state.row.delivery_results = [{ email: 'fixture@example.test', status }]
    await generateReport(config)
    expect(send).not.toHaveBeenCalled()
  })
  it('snapshot persistence failure prevents exporting and sending', async () => {
    state.saveFails = true
    expect((await generateReport(config)).status).toBe('failed')
    expect(pdf).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled()
  })
  it('rejects mismatched report ownership', async () => {
    state.row.client_id = 'other-client'
    await expect(generateReport(config)).rejects.toThrow('scope mismatch')
    expect(render).not.toHaveBeenCalled()
  })
  it('queues atomically with a user-scoped idempotency key', async () => {
    rpc.mockResolvedValue({ data: { reportId: 'r', jobId: 'j' }, error: null })
    await enqueueReportGeneration({ ...config, generatedBy: 'employee1' }, 'same-request')
    expect(rpc).toHaveBeenCalledWith('queue_ad_report', expect.objectContaining({ p_request_key: 'manual:employee1:same-request' }))
  })
  it('scheduled retries use one period/version key', async () => {
    rpc.mockResolvedValue({ data: { reportId: 'r', jobId: 'j' }, error: null })
    await enqueueReportGeneration({ ...config, scheduleId: 'schedule1' })
    expect(rpc).toHaveBeenCalledWith('queue_ad_report', expect.objectContaining({ p_request_key: 'schedule:schedule1:2026-10-01:2026-10-07:v1' }))
  })
})
