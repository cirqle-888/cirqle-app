import { describe, it, expect } from 'vitest'
import { showServiceColumn, serviceColumnSource } from './service-column'

describe('showServiceColumn', () => {
  it('is off unless something says otherwise', () => {
    expect(showServiceColumn({}, {})).toBe(false)
    expect(showServiceColumn(null, null)).toBe(false)
  })

  it('follows the client when the invoice has no opinion', () => {
    expect(showServiceColumn({ show_service_column: null }, { invoice_show_services: true })).toBe(true)
    expect(showServiceColumn({ show_service_column: null }, { invoice_show_services: false })).toBe(false)
  })

  it('lets one invoice override the client either way', () => {
    // Turning it ON for a client who normally does not get it…
    expect(showServiceColumn({ show_service_column: true }, { invoice_show_services: false })).toBe(true)
    // …and OFF for a client who normally does. `false` must beat the client,
    // which is why the override is a nullable boolean and not a plain one.
    expect(showServiceColumn({ show_service_column: false }, { invoice_show_services: true })).toBe(false)
  })

  it('stays off before the migration, when neither column exists', () => {
    // Both read undefined; every existing invoice keeps the shape it has now.
    expect(showServiceColumn({ show_service_column: undefined }, { invoice_show_services: undefined })).toBe(false)
  })
})

describe('serviceColumnSource', () => {
  it('names where the answer came from', () => {
    expect(serviceColumnSource({ show_service_column: true }, { invoice_show_services: false })).toBe('invoice')
    expect(serviceColumnSource({ show_service_column: false }, { invoice_show_services: true })).toBe('invoice')
    expect(serviceColumnSource({}, { invoice_show_services: true })).toBe('client')
    expect(serviceColumnSource({}, {})).toBe('default')
  })
})
