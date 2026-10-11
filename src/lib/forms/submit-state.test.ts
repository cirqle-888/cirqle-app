import { describe, it, expect } from 'vitest'
import {
  IDLE, SAVING, saved, failed, canSubmit, submitLabel,
  missingRequired, requiredFieldMessage,
} from './submit-state'

describe('states', () => {
  it('turns a server error into something the reader can act on', () => {
    expect(failed('Client is required')).toEqual({ status: 'error', message: 'Client is required' })
    // Several of these forms rendered an empty red box when res.error was
    // undefined.
    expect(failed(undefined).message).toBe('Something went wrong. Try again.')
    expect(failed('   ').message).toBe('Something went wrong. Try again.')
  })

  it('records when a save landed', () => {
    const s = saved(1000)
    expect(s).toEqual({ status: 'saved', at: 1000 })
  })
})

describe('canSubmit', () => {
  it('blocks a second click while the first is in flight', () => {
    expect(canSubmit(SAVING)).toBe(false)
    expect(canSubmit(IDLE)).toBe(true)
  })

  it('still respects the form’s own readiness', () => {
    expect(canSubmit(IDLE, false)).toBe(false)
  })

  it('lets a failed save be retried', () => {
    expect(canSubmit(failed('nope'))).toBe(true)
  })
})

describe('submitLabel', () => {
  it('says what is happening while it happens', () => {
    expect(submitLabel(SAVING, { idle: 'Create Quotation' })).toBe('Create Quotation…')
    expect(submitLabel(SAVING, { idle: 'Save', saving: 'Saving' })).toBe('Saving')
  })

  it('keeps the idle label after success', () => {
    // A button that says "Saved" is a button people press again to check.
    expect(submitLabel(saved(1), { idle: 'Save' })).toBe('Save')
  })
})

describe('required fields', () => {
  const fields = [
    { key: 'client_id', label: 'Client' },
    { key: 'title', label: 'Title' },
    { key: 'items', label: 'At least one line' },
  ]

  it('names what is missing, in the words on the labels', () => {
    const missing = missingRequired({ client_id: '', title: ' ', items: [] }, fields)
    expect(requiredFieldMessage(missing))
      .toBe('Client, Title and At least one line are needed before this can be saved.')
  })

  it('reads naturally for one field', () => {
    const missing = missingRequired({ client_id: '', title: 'x', items: [1] }, fields)
    expect(requiredFieldMessage(missing)).toBe('Client is needed before this can be saved.')
  })

  it('says nothing when the form is complete', () => {
    const missing = missingRequired({ client_id: 'c', title: 'x', items: [1] }, fields)
    expect(missing).toEqual([])
    expect(requiredFieldMessage(missing)).toBeNull()
  })

  it('treats false and zero as answers, not omissions', () => {
    const answered = [{ key: 'billable', label: 'Billable' }, { key: 'qty', label: 'Quantity' }]
    expect(missingRequired({ billable: false, qty: 0 }, answered)).toEqual([])
  })

  it('treats a missing key as missing', () => {
    expect(missingRequired({}, fields)).toHaveLength(3)
  })

  it('keeps the declared order so the message matches the form', () => {
    const missing = missingRequired({ title: '' }, fields)
    expect(missing.map(f => f.key)).toEqual(['client_id', 'title', 'items'])
  })
})
