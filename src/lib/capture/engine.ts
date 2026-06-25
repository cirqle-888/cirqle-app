/**
 * Capture Engine — orchestrator.
 *
 * runCapture: classify → detect client → route → prepare a review draft.
 * It performs NO writes. The caller (a permission-guarded server action today,
 * a future source route tomorrow) shows the draft for confirmation, then
 * commits through the target module's own guarded action.
 *
 * Server-only (creates the admin Supabase client).
 */
import { createAdminClient } from '@/lib/supabase/admin'
import { classifyText } from './classify'
import { detectClient } from './client-detect'
import { getAdapter, ROUTABLE_TYPES } from './router'
import type { CaptureClassification, CaptureDraft, CaptureInput, CaptureResult, CaptureType, DetectedClient } from './types'

function unknownDraft(text: string, client: DetectedClient | null): CaptureDraft {
  return {
    type: 'unknown',
    target: '',
    summary: 'Could not auto-detect — choose where this goes',
    client,
    fields: { raw: text },
  }
}

export async function runCapture(input: CaptureInput): Promise<CaptureResult> {
  const text = (input.payload || '').trim()
  if (!text && input.kind !== 'files') return { ok: false, error: 'Nothing to capture.' }

  const admin = createAdminClient()

  // 1. Classify. If the AI is unavailable, fall back to manual routing.
  let classification: CaptureClassification
  try {
    classification = await classifyText(text)
  } catch {
    // AI unavailable (e.g. no GROQ_API_KEY) → fall back to manual routing.
    classification = { type: 'unknown', confidence: 0 }
  }

  // 2. Detect the client once, shared by every adapter.
  const client = await detectClient(admin, input, classification)

  // 3. Route.
  const adapter = getAdapter(classification.type)
  if (!adapter) {
    return { ok: true, classification, draft: unknownDraft(text, client), alternatives: ROUTABLE_TYPES }
  }

  // 4. Prepare a review draft (never writes).
  try {
    const draft = await adapter.prepare(input, classification, { admin, client })
    return { ok: true, classification, draft, alternatives: ROUTABLE_TYPES }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Could not prepare a draft.', classification }
  }
}

/**
 * Force a specific destination (the user redirected a misclassification).
 * Skips AI classification and routes straight to the chosen adapter.
 */
export async function prepareAs(input: CaptureInput, type: CaptureType): Promise<CaptureResult> {
  const text = (input.payload || '').trim()
  const admin = createAdminClient()
  const client = await detectClient(admin, input)
  const classification: CaptureClassification = { type, confidence: 1 }

  const adapter = getAdapter(type)
  if (!adapter) {
    return { ok: true, classification, draft: unknownDraft(text, client), alternatives: ROUTABLE_TYPES }
  }
  try {
    const draft = await adapter.prepare(input, classification, { admin, client })
    return { ok: true, classification, draft, alternatives: ROUTABLE_TYPES }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'Could not prepare a draft.', classification }
  }
}
