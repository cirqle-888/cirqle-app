import { describe, it, expect, vi, beforeEach } from 'vitest'

const metaGraph = vi.fn()
const metaGraphAll = vi.fn()
vi.mock('./client', () => ({ metaGraph, metaGraphAll, redactTokens: (s: string) => s }))
vi.mock('@/lib/assets/ownership', () => ({ resolveDiscoveredOwner: vi.fn() }))
vi.mock('@/lib/integrations/tokens', () => ({ encryptToken: (s: string) => s }))

beforeEach(() => { metaGraph.mockReset(); metaGraphAll.mockReset() })

describe('discoverBusinessPages', () => {
  it('adds granted portfolio Pages and reports ungranted ones, skipping known Pages', async () => {
    metaGraphAll.mockImplementation(async (path: string) => {
      if (path === 'me/businesses') return [{ id: 'biz' }]
      if (path === 'biz/owned_pages') return [{ id: 'known', name: 'Known' }, { id: 'granted', name: 'Granted' }]
      if (path === 'biz/client_pages') return [{ id: 'locked', name: 'Locked' }]
      return []
    })
    metaGraph.mockImplementation(async (id: string) => {
      if (id === 'granted') return { id: 'granted', name: 'Granted', access_token: 'tok' }
      throw new Error('(#10) Requires pages_read_engagement')
    })
    const { discoverBusinessPages } = await import('./accounts')
    const out = await discoverBusinessPages('user', new Set(['known']))
    expect(out.pages.map(p => p.id)).toEqual(['granted'])
    expect(out.ungranted).toEqual([{ id: 'locked', name: 'Locked' }])
    expect(metaGraph).not.toHaveBeenCalledWith('known', expect.anything())
  })

  it('treats a Page read without a Page token as ungranted', async () => {
    metaGraphAll.mockImplementation(async (path: string) =>
      path === 'me/businesses' ? [{ id: 'biz' }] : path === 'biz/owned_pages' ? [{ id: 'p', name: 'P' }] : [])
    metaGraph.mockResolvedValue({ id: 'p', name: 'P' })
    const { discoverBusinessPages } = await import('./accounts')
    const out = await discoverBusinessPages('user', new Set())
    expect(out.pages).toEqual([])
    expect(out.ungranted).toEqual([{ id: 'p', name: 'P' }])
  })

  it('returns nothing when businesses cannot be listed', async () => {
    metaGraphAll.mockRejectedValue(new Error('no business_management'))
    const { discoverBusinessPages } = await import('./accounts')
    expect(await discoverBusinessPages('user', new Set())).toEqual({ pages: [], ungranted: [] })
  })
})
