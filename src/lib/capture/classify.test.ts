import { describe, it, expect } from 'vitest'
import { parseClassification, CONFIDENCE_THRESHOLD } from './classify'

describe('parseClassification', () => {
  it('passes through a valid high-confidence type', () => {
    const c = parseClassification({ type: 'request', confidence: 0.9 })
    expect(c.type).toBe('request')
    expect(c.confidence).toBe(0.9)
  })

  it('maps invalid/missing types to "unknown"', () => {
    expect(parseClassification({ type: 'banana', confidence: 0.9 }).type).toBe('unknown')
    expect(parseClassification({}).type).toBe('unknown')
  })

  it('downgrades low-confidence guesses to "unknown" (but keeps the score)', () => {
    const c = parseClassification({ type: 'offer', confidence: 0.2 })
    expect(c.type).toBe('unknown')
    expect(c.confidence).toBe(0.2)
  })

  it('keeps a guess exactly at the threshold', () => {
    expect(parseClassification({ type: 'offer', confidence: CONFIDENCE_THRESHOLD }).type).toBe('offer')
  })

  it('clamps out-of-range confidence', () => {
    expect(parseClassification({ type: 'task', confidence: 5 }).confidence).toBe(1)
    // -2 clamps to 0, which is below threshold → unknown
    expect(parseClassification({ type: 'task', confidence: -2 }).type).toBe('unknown')
  })

  it('defaults a typed-but-unscored guess to 0.5 and keeps it', () => {
    const c = parseClassification({ type: 'invoice' })
    expect(c.confidence).toBe(0.5)
    expect(c.type).toBe('invoice')
  })

  it('extracts and trims a client hint', () => {
    expect(parseClassification({ type: 'request', confidence: 0.8, client_hint: '  Acme  ' }).hints)
      .toEqual({ client: 'Acme' })
  })

  it('omits hints when client_hint is null or blank', () => {
    expect(parseClassification({ type: 'request', confidence: 0.8, client_hint: null }).hints).toBeUndefined()
    expect(parseClassification({ type: 'request', confidence: 0.8, client_hint: '   ' }).hints).toBeUndefined()
  })
})
