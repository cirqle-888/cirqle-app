/**
 * Capture Engine — shared types.
 *
 * The Capture Engine is the single, source-agnostic entry point for all
 * manually captured content. A source (clipboard, drag-drop, quick action, and
 * later Meta/Email/Telegram…) produces a normalized `CaptureInput`; everything
 * after it — AI classification, client detection, routing, draft preparation —
 * is identical regardless of source. Adding a new source never touches the
 * router, the adapters, or the UI.
 *
 * Manual by design: the engine only ever PREPARES a draft for human review.
 * It never writes to the database. Commit goes through each module's existing,
 * permission-guarded action after the user confirms.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Destinations the Smart Router can dispatch to (plus the catch-all). */
export type CaptureType =
  | 'request' | 'offer' | 'invoice' | 'client' | 'task' | 'quotation' | 'advertising' | 'unknown'

/**
 * Where the content came from. The desktop sources ship in v1; the string
 * union stays open so future sources (whatsapp_meta, email, telegram, …) are
 * additive with no type churn downstream.
 */
export type CaptureSource =
  | 'clipboard' | 'drag_drop' | 'quick_action' | 'manual_paste' | (string & {})

export interface CaptureMetadata {
  /** Sender phone (e.g. the WhatsApp chat's number) — strongest client signal. */
  phone?: string | null
  email?: string | null
  senderName?: string | null
  /** Which inbox/profile the content came from (e.g. WhatsApp Sales/Support). */
  sourceProfile?: string | null
}

export interface CaptureInput {
  source: CaptureSource
  kind: 'text' | 'files' | 'contact'
  /** Raw text payload (text/contact kinds). File handling is a later phase. */
  payload: string
  metadata?: CaptureMetadata
}

export interface CaptureClassification {
  type: CaptureType
  /** 0..1. Below the engine's threshold we downgrade to 'unknown' for review. */
  confidence: number
  /** Loose hints the classifier surfaced (e.g. { client: 'Acme' }). */
  hints?: Record<string, unknown>
}

/** A client the engine pre-selected from the input's metadata or text. */
export interface DetectedClient {
  id: string
  name: string
  matchedBy: 'phone' | 'email' | 'name'
}

/**
 * The draft an adapter prepares for review. The engine NEVER persists this —
 * the UI renders it for confirm / edit / redirect, then the module's own action
 * commits it.
 */
export interface CaptureDraft {
  type: CaptureType
  /** Existing module route the review UI sends the user to confirm/commit. */
  target: string
  /** One-line, human-readable summary of what will be created. */
  summary: string
  /** Prefilled values for the target module's form. */
  fields: Record<string, unknown>
  client?: DetectedClient | null
}

export interface CaptureResult {
  ok: boolean
  error?: string
  classification?: CaptureClassification
  draft?: CaptureDraft
  /** Destinations the user can redirect to if the AI guessed wrong. */
  alternatives?: CaptureType[]
}

/** Read-only context handed to every adapter's prepare(). */
export interface AdapterContext {
  admin: SupabaseClient
  /** Client detected once by the engine and shared across adapters. */
  client: DetectedClient | null
}

export interface ModuleAdapter {
  type: CaptureType
  /** Build a review draft from the input + classification. MUST NOT write. */
  prepare(
    input: CaptureInput,
    classification: CaptureClassification,
    ctx: AdapterContext,
  ): Promise<CaptureDraft>
}
