/**
 * Meta `actions` → Cirqle metric columns.
 *
 * An insights row lists conversion events as `actions: [{ action_type, value }]`.
 * Meta returns several overlapping VIEWS of the same event (e.g. `purchase`,
 * `omni_purchase`, `offsite_conversion.fb_pixel_purchase` can all carry the
 * same purchases), so each metric takes the FIRST type present from its
 * priority list — never a sum, which would double- or triple-count.
 *
 * Meta omits action types with no events that day, so an absent type reads
 * as 0 for that day. That is accurate for a day that was synced; days that
 * were never synced are a different thing, handled by the report's data
 * coverage check (missing rows), not here.
 *
 * VERIFY against a real account before relying on purchases/messages: the
 * type names follow Meta's documented action types and common integrations,
 * but they have not been reconciled with Ads Manager for a Cirqle account.
 */

export interface MetaActionEntry {
  action_type?: string
  value?: string | number
}

export interface MetaActionCounts {
  leads: number
  /** Messaging conversations started (Messenger / WhatsApp / Instagram Direct). */
  messages: number
  purchases: number
  landingPageViews: number
}

/** Priority lists — first present wins. Exported for tests and docs. */
export const META_ACTION_TYPES = {
  // 'lead' is Meta's total-leads rollup; the onsite/offsite variants are
  // components of it.
  leads: ['lead'],
  messages: ['onsite_conversion.messaging_conversation_started_7d'],
  purchases: ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase'],
  landingPageViews: ['landing_page_view'],
} as const satisfies Record<keyof MetaActionCounts, readonly string[]>

export function parseMetaActions(actions: unknown): MetaActionCounts {
  const byType = new Map<string, number>()
  if (Array.isArray(actions)) {
    for (const a of actions as MetaActionEntry[]) {
      if (!a || typeof a.action_type !== 'string') continue
      const v = Number(a.value)
      if (!Number.isFinite(v)) continue
      // A type should appear once per row; if Meta repeats it, keep the first.
      if (!byType.has(a.action_type)) byType.set(a.action_type, v)
    }
  }
  const first = (types: readonly string[]) => {
    for (const t of types) {
      const v = byType.get(t)
      if (v != null) return v
    }
    return 0
  }
  return {
    leads: first(META_ACTION_TYPES.leads),
    messages: first(META_ACTION_TYPES.messages),
    purchases: first(META_ACTION_TYPES.purchases),
    landingPageViews: first(META_ACTION_TYPES.landingPageViews),
  }
}
