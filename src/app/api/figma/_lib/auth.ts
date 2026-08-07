import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared auth + CORS for every /api/figma/* route.
 *
 * One place instead of six copies so that:
 *  - the secret comparison and its fail-closed stance can't drift apart
 *    between routes, and
 *  - per-designer API keys can be added later by extending `FigmaPrincipal`
 *    and this function alone — no route call site changes.
 *
 * Auth today: `Authorization: Bearer <offer_sheet_secret>` — the workspace
 * secret that already exists in company_settings for the Sheets sync. An
 * unset secret refuses every request rather than accepting them all.
 *
 * CORS: the plugin UI runs in an iframe with a `null` origin, so the wildcard
 * is the only workable value. It is safe here because the bearer token is the
 * actual gate — CORS only decides whether the browser hands the response to
 * the page, and an unauthorized caller gets nothing worth handing over.
 *
 * Version gate: the plugin identifies itself via
 * `X-Cirqle-Plugin: cirqle-studio/<version>+<build> (<platform>)`. When the
 * workspace sets `company_settings.figma_min_plugin_version`, older plugins
 * get a 426 with a friendly update message instead of half-working against a
 * newer server. Unset = no gate; a request with no header is treated as a
 * pre-versioning plugin (version 0.0.0) and gated only when a minimum is set.
 */

export const FIGMA_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-cirqle-plugin',
}

/** Shared OPTIONS handler — every figma route re-exports this. */
export async function figmaOptions() {
  return new NextResponse(null, { status: 204, headers: FIGMA_CORS_HEADERS })
}

/** Who is calling. Today always the workspace; later a designer key. */
export type FigmaPrincipal = { kind: 'workspace' }

/** Parsed from the X-Cirqle-Plugin header — debugging/support only. */
export interface PluginInfo {
  name: string
  version: string
  build: string | null
  platform: string | null
}

export type FigmaAuthResult =
  | { ok: true; admin: SupabaseClient; principal: FigmaPrincipal; plugin: PluginInfo | null }
  | { ok: false; response: NextResponse }

/** `cirqle-studio/1.3.0+42 (desktop)` → {name, version, build, platform}. */
export function parsePluginHeader(raw: string | null): PluginInfo | null {
  const value = (raw || '').trim()
  if (!value) return null
  const m = value.match(/^([a-z0-9-]+)\/(\d+\.\d+\.\d+)(?:\+([\w.-]+))?(?:\s+\(([^)]+)\))?$/i)
  if (!m) return { name: value.slice(0, 40), version: '0.0.0', build: null, platform: null }
  return { name: m[1], version: m[2], build: m[3] || null, platform: m[4] ? m[4].toLowerCase() : null }
}

/** Minimal semver compare — enough for x.y.z, no dependency. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

/** Best-effort operational event for the admin Plugin Health panel.
 *  Never throws into a request path; a lost event is a non-event. */
export async function logFigmaEvent(
  admin: SupabaseClient,
  kind: 'save_ok' | 'save_conflict' | 'save_failed' | 'image_upload_ok' | 'image_upload_failed' | 'auth_failed' | 'update_required',
  extra?: { campaignId?: string | null; plugin?: PluginInfo | null; durationMs?: number; detail?: string },
): Promise<void> {
  try {
    await admin.from('figma_events').insert({
      kind,
      campaign_id: extra?.campaignId || null,
      plugin_version: extra?.plugin?.version || null,
      plugin_build: extra?.plugin?.build || null,
      platform: extra?.plugin?.platform || null,
      duration_ms: extra?.durationMs != null ? Math.round(extra.durationMs) : null,
      detail: extra?.detail ? String(extra.detail).slice(0, 500) : null,
    })
  } catch { /* observability, never availability */ }
}

export async function verifyFigmaAuth(req: NextRequest): Promise<FigmaAuthResult> {
  const admin = createAdminClient()
  const plugin = parsePluginHeader(req.headers.get('x-cirqle-plugin'))

  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
  const { data: secretRow } = await admin
    .from('company_settings')
    .select('value')
    .eq('key', 'offer_sheet_secret')
    .maybeSingle()
  const secret = ((secretRow as { value?: string } | null)?.value || '').trim()

  // Fail closed: an unset secret refuses every request rather than
  // accepting them all (same stance as the shared Apps Script).
  if (!secret || !bearer || bearer !== secret) {
    void logFigmaEvent(admin, 'auth_failed', { plugin, detail: bearer ? 'wrong secret' : 'no bearer' })
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'Unauthorized. Paste the shared secret from Apps → Offer Intake → Shared sync script.' },
        { status: 401, headers: FIGMA_CORS_HEADERS },
      ),
    }
  }

  // Version gate — only when the workspace has set a minimum.
  const { data: minRow } = await admin
    .from('company_settings')
    .select('value')
    .eq('key', 'figma_min_plugin_version')
    .maybeSingle()
  const minVersion = ((minRow as { value?: string } | null)?.value || '').trim()
  if (minVersion && /^\d+\.\d+\.\d+$/.test(minVersion)) {
    const current = plugin?.version || '0.0.0'
    if (compareVersions(current, minVersion) < 0) {
      void logFigmaEvent(admin, 'update_required', { plugin, detail: `min ${minVersion}` })
      return {
        ok: false,
        response: NextResponse.json(
          {
            ok: false,
            updateRequired: true,
            minVersion,
            currentVersion: current,
            error: `Please update Cirqle Studio — you have ${current === '0.0.0' ? 'an older version' : current}, the minimum is ${minVersion}. Re-import the latest plugin from the design team's folder.`,
          },
          { status: 426, headers: FIGMA_CORS_HEADERS },
        ),
      }
    }
  }

  return { ok: true, admin, principal: { kind: 'workspace' }, plugin }
}
