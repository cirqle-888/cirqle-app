import { describe, it, expect } from 'vitest'
import {
  buildPendingSummary, pendingShareText, pendingCardHtml, whatsappUrl, SHARE_LIMIT, type ShareableRow,
} from './my-work-share'

const TODAY = '2026-11-18'
const row = (o: Partial<ShareableRow>): ShareableRow => ({
  source: 'request', ref_no: 45, title: 'Poster', status: 'submitted', due_date: null,
  client_name: 'Elara Luxe Perfume', service_name: 'Social Media Poster', ...o,
})

describe('buildPendingSummary', () => {
  it('splits pending from with-the-client, leaves done out, and puts overdue first', () => {
    const s = buildPendingSummary('CQID004', [
      row({ title: 'Later', due_date: '2026-11-30' }),
      row({ title: 'Late', due_date: '2026-11-10' }),
      row({ title: 'Undated' }),
      row({ title: 'Review', status: 'delivered', due_date: '2026-11-01' }),
      row({ title: 'Finished', status: 'completed' }),
    ], TODAY)
    expect(s.pending.map(i => i.title)).toEqual(['Late', 'Later', 'Undated'])
    expect(s.withClient.map(i => i.title)).toEqual(['Review'])
    expect(s.overdueCount).toBe(1)
    // Waiting on the client is not this person's lateness.
    expect(s.withClient[0].overdue).toBe(false)
  })

  it('gives requests their REQ number and planned work none', () => {
    const s = buildPendingSummary('Me', [row({ ref_no: 7 }), row({ source: 'plan', ref_no: null, status: '' })], TODAY)
    expect(s.pending.map(i => i.ref).sort()).toEqual(['REQ-0007', null].sort())
  })
})

describe('pendingShareText', () => {
  it('reads as a WhatsApp message with counts, overdue marked', () => {
    const text = pendingShareText(buildPendingSummary('CQID004', [
      row({ title: 'Prescent Price Post', due_date: '2026-11-10' }),
      row({ title: 'Milkees', status: 'delivered', client_name: 'Sea Star' }),
    ], TODAY))
    expect(text).toContain('*CQID004 — pending work* (18 Nov)')
    expect(text).toContain('1 to do · 1 overdue · 1 with the client')
    expect(text).toContain('🔴 Prescent Price Post — Elara Luxe Perfume · overdue since 10 Nov · REQ-0045')
    expect(text).toContain('*With the client (1)*')
  })

  it('says so plainly when nothing is pending', () => {
    expect(pendingShareText(buildPendingSummary('Me', [row({ status: 'completed' })], TODAY)))
      .toContain('Nothing pending')
  })

  it('caps a long list instead of sending a wall of text', () => {
    const rows = Array.from({ length: SHARE_LIMIT + 5 }, (_, n) => row({ title: `Item ${n}` }))
    expect(pendingShareText(buildPendingSummary('Me', rows, TODAY))).toContain('+ 5 more')
  })
})

describe('pendingCardHtml', () => {
  it('escapes titles so a client name cannot break the card', () => {
    const html = pendingCardHtml(buildPendingSummary('Me', [row({ title: '<b>Sale</b> & "more"' })], TODAY))
    expect(html).toContain('&lt;b&gt;Sale&lt;/b&gt; &amp; &quot;more&quot;')
    expect(html).not.toContain('<b>Sale</b>')
  })

  it('loads nothing from outside, so it renders the same on every device', () => {
    const html = pendingCardHtml(buildPendingSummary('Me', [row({})], TODAY))
    expect(html).not.toMatch(/(src|href)=|url\(|@import/)
  })
})

describe('whatsappUrl', () => {
  it('opens the chat picker without a number, and the person with one', () => {
    expect(whatsappUrl('hi')).toBe('https://wa.me/?text=hi')
    expect(whatsappUrl('hi', '98470 12345')).toBe('https://wa.me/919847012345?text=hi')
    expect(whatsappUrl('a b', '+971 50 123 4567')).toBe('https://wa.me/971501234567?text=a%20b')
  })
})
