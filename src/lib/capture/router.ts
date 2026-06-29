/**
 * Capture Engine — Smart Router.
 *
 * A registry of module adapters keyed by classification type. Adding a module
 * to the engine is a one-line registration here; the engine, sources, and UI
 * are untouched.
 */
import type { CaptureType, ModuleAdapter } from './types'
import { requestAdapter } from './adapters/request'
import { offerAdapter } from './adapters/offer'
import { invoiceAdapter } from './adapters/invoice'
import { clientAdapter } from './adapters/client'
import { taskAdapter } from './adapters/task'
import { quotationAdapter } from './adapters/quotation'
import { advertisingAdapter } from './adapters/advertising'

const ADAPTERS: ModuleAdapter[] = [
  requestAdapter, offerAdapter, invoiceAdapter, clientAdapter, taskAdapter, quotationAdapter,
  advertisingAdapter,
]

const REGISTRY = new Map<CaptureType, ModuleAdapter>(ADAPTERS.map(a => [a.type, a]))

/** The destinations a user can redirect to when the AI guesses wrong. */
export const ROUTABLE_TYPES: CaptureType[] = ADAPTERS.map(a => a.type)

export function getAdapter(type: CaptureType): ModuleAdapter | null {
  return REGISTRY.get(type) ?? null
}
