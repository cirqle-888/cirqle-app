import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Workspace feature flags for the offer/Figma subsystem, stored as
 * company_settings rows (the de-facto config store — same table as
 * offer_sheet_secret, offer_archive_retention_days, …).
 *
 * Values are 'on' / 'off'; a missing row falls back to the caller's default,
 * so features can ship dark (defaultOn=false) and be enabled later with a
 * one-row settings change instead of a deploy — and, more importantly, be
 * switched OFF in production without rolling back everything else.
 */

export type OfferFeatureKey =
  | 'feature_offer_revisions'      // Phase 8 — campaign version history
  | 'feature_offer_timeline'       // Phase 7 — activity timeline events
  | 'feature_figma_catalog'        // Phase 5 — plugin catalog endpoints
  | 'feature_figma_image_upload'   // Phase 6 — PNG upload from Figma

export async function isFeatureEnabled(
  admin: SupabaseClient,
  key: OfferFeatureKey,
  defaultOn: boolean,
): Promise<boolean> {
  try {
    const { data } = await admin
      .from('company_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle()
    const value = ((data as { value?: string } | null)?.value || '').trim().toLowerCase()
    if (value === 'on') return true
    if (value === 'off') return false
    return defaultOn
  } catch {
    // Flags are convenience, never availability: on any read failure fall
    // back to the default rather than taking the feature down.
    return defaultOn
  }
}

/** Standard JSON body a flagged route returns when its feature is off. */
export const FEATURE_DISABLED_BODY = { ok: false, disabled: true, error: 'This feature is currently turned off for the workspace.' } as const
