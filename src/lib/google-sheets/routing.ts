/**
 * Pure routing logic for the offer sheet sync: which Apps Script receives which
 * slice of a campaign, and with what payload.
 *
 * Deliberately separate from sync.ts, which reaches the database and the
 * notification system (and through it `server-only`). Keeping these functions
 * dependency-free is what makes the backward-compatibility guarantee testable —
 * see sync.test.ts.
 */

import type { OfferSheetProduct } from '@/lib/offer-sheet'

/** A campaign product as the router sees it: sheet columns plus its group. */
export type RoutedProduct = OfferSheetProduct & { group_id?: string | null }

/** A configured offer group — one flyer output stream for a client. */
export interface OfferGroup {
  id: string
  name: string
  sheet_url: string | null
  sheet_id: string | null
  sheet_tab_name: string | null
  apps_script_url: string | null
}

/** One flyer stream's rows and the script that should receive them. */
export interface SyncDestination {
  groupId: string | null
  groupName: string | null
  targetUrl: string
  routePayload: Record<string, unknown>
  products: RoutedProduct[]
}

export type ResolveResult =
  | { ok: true; destinations: SyncDestination[] }
  | { ok: false; error: string }

/**
 * Pull the spreadsheet ID out of a Google Sheets link (or accept a raw ID).
 * `https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0` → `<ID>`.
 */
export function extractSheetId(url: string | null | undefined): string | null {
  if (!url) return null
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  if (m) return m[1]
  const trimmed = url.trim()
  return /^[a-zA-Z0-9_-]{30,}$/.test(trimmed) ? trimmed : null
}

/**
 * Decide which script and spreadsheet each slice of the campaign goes to.
 *
 * The single most important guarantee here: a client with NO groups produces
 * exactly one destination whose payload is identical to the pre-groups
 * implementation. Every existing client is on that path.
 */
export function resolveDestinations({
  client,
  groups,
  products,
  globalWebhook,
  sharedSecret,
}: {
  client: { offer_sheet_webhook_url?: string | null; offer_sheet_url?: string | null } | null
  groups: OfferGroup[]
  products: RoutedProduct[]
  globalWebhook: string
  sharedSecret: string
}): ResolveResult {
  const legacyWebhook = client?.offer_sheet_webhook_url || ''

  // ── Legacy / ungrouped path ────────────────────────────────────────────────
  if (groups.length === 0) {
    if (legacyWebhook) {
      return {
        ok: true,
        destinations: [{ groupId: null, groupName: null, targetUrl: legacyWebhook, routePayload: {}, products }],
      }
    }
    if (globalWebhook && client?.offer_sheet_url) {
      const spreadsheetId = extractSheetId(client.offer_sheet_url)
      if (!spreadsheetId) return { ok: false, error: 'The client Sheet link is not a valid Google Sheets URL.' }
      return {
        ok: true,
        destinations: [{
          groupId: null,
          groupName: null,
          targetUrl: globalWebhook,
          routePayload: { spreadsheetId, secret: sharedSecret },
          products,
        }],
      }
    }
    return {
      ok: false,
      error: globalWebhook
        ? 'No Google Sheet linked for this client. Paste the client’s Google Sheet link in Offer Intake settings.'
        : 'Google Sheet sync is not set up yet. Connect the shared script in Offer Intake settings.',
    }
  }

  // ── Grouped path ───────────────────────────────────────────────────────────
  // A legacy bound script writes to the one sheet it lives in and (on older
  // deployments) ignores sheetName, so routing several groups through it would
  // have each group silently overwrite the last. Refuse rather than corrupt.
  const groupsNeedingLegacy = groups.filter(g => !g.apps_script_url && !(g.sheet_id || g.sheet_url))
  if (legacyWebhook && groups.length > 1 && groupsNeedingLegacy.length > 1) {
    return {
      ok: false,
      error: 'This client uses a per-client Apps Script but has several categories without their own Google Sheet. Give each category its own Sheet link (or its own Apps Script URL) so they do not overwrite each other.',
    }
  }

  const destinations: SyncDestination[] = []

  // Products whose group was deleted or never set still belong somewhere: they
  // ride along with the first group rather than being silently dropped.
  const knownIds = new Set(groups.map(g => g.id))
  const orphans = products.filter(p => !p.group_id || !knownIds.has(p.group_id))

  for (const [index, group] of groups.entries()) {
    const groupProducts = products.filter(p => p.group_id === group.id)
    const slice = index === 0 ? [...groupProducts, ...orphans] : groupProducts
    if (slice.length === 0) continue // nothing to write; don't clear their sheet

    const spreadsheetId = group.sheet_id || extractSheetId(group.sheet_url) || null
    const script = group.apps_script_url || (spreadsheetId ? globalWebhook : legacyWebhook)

    if (!script) {
      return {
        ok: false,
        error: `Category “${group.name}” has no Apps Script to sync through. Connect the shared script in Offer Intake settings, or give this category its own script URL.`,
      }
    }
    if (!group.apps_script_url && !spreadsheetId && !legacyWebhook) {
      return { ok: false, error: `Category “${group.name}” has no Google Sheet linked.` }
    }

    const routePayload: Record<string, unknown> = {}
    if (spreadsheetId) {
      routePayload.spreadsheetId = spreadsheetId
      routePayload.secret = sharedSecret
    }
    if (group.sheet_tab_name) routePayload.sheetName = group.sheet_tab_name

    destinations.push({
      groupId: group.id,
      groupName: group.name,
      targetUrl: script,
      routePayload,
      products: slice,
    })
  }

  if (destinations.length === 0) return { ok: false, error: 'No products to sync.' }
  return { ok: true, destinations }
}
