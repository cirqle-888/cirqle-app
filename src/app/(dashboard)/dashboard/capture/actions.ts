'use server'

/**
 * Capture surface — server actions.
 *
 * analyze* only PREPARE a draft (read-only AI parsing); being a signed-in
 * employee is the gate. commit* go through each module's own
 * permission-guarded action, so capture never bypasses module security.
 */

import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { runCapture, prepareAs } from '@/lib/capture/engine'
import { createManualRequest } from '@/app/(dashboard)/dashboard/requests/actions'
import type { CaptureInput, CaptureResult, CaptureType } from '@/lib/capture/types'

async function ensureSignedIn(): Promise<string | null> {
  return resolveCurrentEmployeeId()
}

/** Classify + route + prepare a review draft for pasted/forwarded content. */
export async function analyzeCapture(input: CaptureInput): Promise<CaptureResult> {
  if (!(await ensureSignedIn())) return { ok: false, error: 'Not signed in.' }
  return runCapture(input)
}

/** Re-prepare for a destination the user chose (misclassification redirect). */
export async function analyzeCaptureAs(input: CaptureInput, type: CaptureType): Promise<CaptureResult> {
  if (!(await ensureSignedIn())) return { ok: false, error: 'Not signed in.' }
  return prepareAs(input, type)
}

/** Commit a reviewed request draft via the Requests module's own action. */
export async function commitRequestCapture(fields: {
  clientId?: string | null
  title?: string
  description?: string
  serviceId?: string | null
  dueDate?: string | null
}): Promise<{ ok: boolean; error?: string; data?: any }> {
  if (!fields.clientId) {
    return { ok: false, error: 'A client is required — none was detected. Open it in Requests to pick one.' }
  }
  return createManualRequest({
    clientId: fields.clientId,
    title: fields.title || '',
    description: fields.description || '',
    serviceId: fields.serviceId ?? null,
    dueDate: fields.dueDate ?? null,
  })
}
