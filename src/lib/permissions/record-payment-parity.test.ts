import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { RECORD_PAYMENT_PERMS, PERMS } from './keys'

/**
 * Recording a payment must mean the same thing wherever it is done.
 *
 * It did not. The follow-ups screen accepted billing.edit OR
 * billing.view_workflow; the invoices screen demanded billing.edit alone. Both
 * call the same lib/finance/record-payment, against the same invoice, writing
 * the same rows — so the stricter gate protected nothing, it just told someone
 * "Permission denied." on one screen for something they could do on another.
 *
 * The UI made it worse by offering the button on invoice status alone: the
 * whole payment form was filled in before the refusal arrived.
 */

const SRC = join(process.cwd(), 'src')
const INVOICES = join(SRC, 'app/(dashboard)/dashboard/invoices/actions.ts')
const FOLLOWUPS = join(SRC, 'app/(dashboard)/dashboard/invoices/follow-ups/actions.ts')
const CLIENT = join(SRC, 'app/(dashboard)/dashboard/invoices/invoices-client.tsx')

describe('recording a payment means one thing', () => {
  it('the shared list is what both screens actually use', () => {
    for (const file of [INVOICES, FOLLOWUPS]) {
      expect(
        readFileSync(file, 'utf8'),
        `${file} must gate on RECORD_PAYMENT_PERMS, not its own list`,
      ).toContain('RECORD_PAYMENT_PERMS')
    }
  })

  it('neither screen has gone back to requiring billing.edit alone', () => {
    const invoices = readFileSync(INVOICES, 'utf8')
    const at = invoices.indexOf('export async function recordInvoicePayment')
    expect(at, 'recordInvoicePayment has moved or been renamed').toBeGreaterThan(-1)
    const body = invoices.slice(at, at + 900)
    expect(body).toMatch(/requireAnyPermission\(\s*RECORD_PAYMENT_PERMS\s*\)/)
    expect(body).not.toMatch(/requirePermission\(\s*PERMS\.BILLING_EDIT\s*\)/)
  })

  it('collections roles can record a payment, not just billing editors', () => {
    // The point of the fix: someone who chases invoices holds view_workflow,
    // and recording the money that arrives is the end of that job.
    expect(RECORD_PAYMENT_PERMS).toContain(PERMS.BILLING_VIEW_WORKFLOW)
    expect(RECORD_PAYMENT_PERMS).toContain(PERMS.BILLING_EDIT)
  })

  it('the button is gated on the same rule the server enforces', () => {
    // Not on invoice status alone, which is what let the app present a form it
    // was always going to reject.
    const client = readFileSync(CLIENT, 'utf8')
    expect(client).toMatch(/const canRecordPayment\s*=/)
    expect(client).toMatch(/RECORD_PAYMENT_PERMS\.some/)
    expect(client).toMatch(/canRecordPayment && \['sent', 'partial', 'overdue'\]/)
  })
})
