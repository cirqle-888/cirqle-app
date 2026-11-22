import { describe, it, expect } from 'vitest'
import { brandOfService, brandOfTask, buildBrandGraph, categoriesOfBrand, clientBrandMap, filterToBrand, servicesOfBrand } from './scope'
import { taskNoun, type Brand } from './brands'

const brand = (o: Partial<Brand>): Brand => ({
  id: 'x', name: 'X', slug: 'x', tagline: null, color: null, logo_url: null, whatsapp_number: null, website: null,
  is_default: false, is_active: true, show_on_invoices: false, display_order: 0, ...o,
})
const brands = [
  brand({ id: 'works', name: 'Cirqle Works', is_default: true }),
  brand({ id: 'flyers', name: 'Cirqle Flyers', display_order: 1 }),
  brand({ id: 'memoura', name: 'Memoura', display_order: 2, task_label: 'Order' }),
]
const g = buildBrandGraph(
  brands,
  [
    { id: 'cat-flyers', brand_id: 'flyers' },
    { id: 'cat-gifts', brand_id: 'memoura' },
    { id: 'cat-social', brand_id: null },          // default brand
  ],
  [
    { id: 'svc-flyer', category_id: 'cat-flyers' },
    { id: 'svc-mug', category_id: 'cat-gifts' },
    { id: 'svc-post', category_id: 'cat-social' },
    { id: 'svc-odd', category_id: 'cat-social', brand_id: 'memoura' },   // override wins
    { id: 'svc-loose', category_id: null },
  ],
)

describe('buildBrandGraph', () => {
  it('gives departments their brand, NULL → the default brand', () => {
    expect(g.categoryBrand.get('cat-social')).toBe('works')
    expect([...categoriesOfBrand(g, 'memoura')]).toEqual(['cat-gifts'])
  })
  it('gives a service its own override, else its department’s brand', () => {
    expect(brandOfService(g, 'svc-flyer')).toBe('flyers')
    expect(brandOfService(g, 'svc-odd')).toBe('memoura')
    expect(brandOfService(g, 'svc-loose')).toBe('works')
    expect(brandOfService(g, null)).toBe('works')
    expect([...servicesOfBrand(g, 'memoura')].sort()).toEqual(['svc-mug', 'svc-odd'])
  })
  it('works with no brands at all', () => {
    const empty = buildBrandGraph([], [], [])
    expect(brandOfService(empty, 'anything')).toBeNull()
  })
})

describe('brandOfTask', () => {
  it('reads internal work from its own brand', () => {
    expect(brandOfTask(g, { client_id: null, service_id: 'svc-post', brand_id: 'memoura' })).toBe('memoura')
  })
  it('reads client work from its service — a client task never carries a brand of its own', () => {
    expect(brandOfTask(g, { client_id: 'c1', service_id: 'svc-mug', brand_id: 'flyers' })).toBe('memoura')
  })
  it('falls back to the default brand', () => {
    expect(brandOfTask(g, { client_id: 'c1', service_id: null })).toBe('works')
    expect(brandOfTask(g, { client_id: null, service_id: null, brand_id: 'gone' })).toBe('works')
  })
})

describe('clientBrandMap', () => {
  const m = clientBrandMap(g, {
    clients: [{ id: 'seastar' }, { id: 'aunty' }, { id: 'filed', department_id: 'cat-flyers' }, { id: 'new' }],
    pricing: [{ client_id: 'seastar', service_id: 'svc-flyer' }, { client_id: 'filed', service_id: 'svc-post' }],
    tasks: [
      { client_id: 'seastar', service_id: 'svc-post' },   // also buys social → two brands
      { client_id: 'aunty', service_id: 'svc-mug' },       // a Memoura customer via an order
    ],
  })
  it('puts a client in every brand it buys from', () => {
    expect([...m.get('seastar')!].sort()).toEqual(['flyers', 'works'])
    expect([...m.get('aunty')!]).toEqual(['memoura'])
  })
  it('lets a department override decide alone', () => {
    expect([...m.get('filed')!]).toEqual(['flyers'])
  })
  it('leaves a client with nothing in no brand', () => {
    expect(m.has('new')).toBe(false)
  })
})

describe('filterToBrand / taskNoun', () => {
  it('narrows only when a brand is chosen', () => {
    const rows = [{ b: 'works' }, { b: 'memoura' }]
    expect(filterToBrand(rows, null, r => r.b)).toHaveLength(2)
    expect(filterToBrand(rows, 'memoura', r => r.b)).toEqual([{ b: 'memoura' }])
  })
  it('names the work', () => {
    expect(taskNoun(brands[2])).toEqual({ one: 'Order', many: 'Orders' })
    expect(taskNoun(null)).toEqual({ one: 'Task', many: 'Tasks' })
  })
})
