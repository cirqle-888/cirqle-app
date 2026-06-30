/**
 * Branding Engine
 *
 * Resolves the BrandConfig for a given client. Falls back to Cirqle
 * defaults if no client_branding row exists yet.
 *
 * white_label_mode controls whose identity appears on report outputs:
 *   'cirqle' → Cirqle name/logo everywhere (default)
 *   'client' → Client logo/name; Cirqle hidden
 *   'agency' → Agency logo/name; client is the document subject
 */

import { createAdminClient } from '@/lib/supabase/server'
import type { BrandConfig, WhiteLabelMode } from './types'

const CIRQLE_DEFAULTS = {
  agencyName: 'Marketing Cirqle',
  primaryColor: '#7C3AED',
  secondaryColor: '#A78BFA',
  accentColor: '#F59E0B',
  agencyLogoUrl: null as string | null,
  contactEmail: 'farooq@cirqle.work',
  contactPhone: null as string | null,
  contactWebsite: 'https://cirqle.work',
  footerText: null as string | null,
  showPoweredBy: true,
} as const

/**
 * Resolves BrandConfig for a client.
 * Never throws — always returns a valid BrandConfig.
 */
export async function resolveBrandConfig(
  clientId: string,
  clientName: string,
): Promise<BrandConfig> {
  const admin = createAdminClient()
  const companySettings = await getCompanySettings(admin)

  try {
    const { data } = await admin
      .from('client_branding')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle()

    if (data) {
      const cfg = mapRowToBrandConfig(data, clientName)
      return { 
        ...cfg, 
        agencyLogoUrl: cfg.agencyLogoUrl ?? companySettings.logoUrl,
        backgroundDesign: companySettings.bgDesign,
        bgImageTopUrl: companySettings.bgTopUrl,
        bgImageBottomUrl: companySettings.bgBottomUrl,
      }
    }
  } catch {
    // Silently fall through to defaults
  }

  const cfg = buildDefaultBrandConfig(clientName)
  return { 
    ...cfg, 
    agencyLogoUrl: cfg.agencyLogoUrl ?? companySettings.logoUrl,
    backgroundDesign: companySettings.bgDesign,
    bgImageTopUrl: companySettings.bgTopUrl,
    bgImageBottomUrl: companySettings.bgBottomUrl,
  }
}

/**
 * The agency (Cirqle) logo for reports comes from Settings → Company → Branding,
 * stored in company_settings. Prefer the light-mode logo (reports are on white).
 */
async function getCompanySettings(admin: ReturnType<typeof createAdminClient>) {
  try {
    const { data } = await admin
      .from('company_settings')
      .select('key, value')
      .in('key', ['logo_url_light', 'logo_url', 'invoice_bg_style', 'invoice_bg_design', 'invoice_bg_image_top_url', 'invoice_bg_image_bottom_url'])
    const map = new Map((data ?? []).map((r: any) => [r.key, r.value]))
    return {
      logoUrl: (map.get('logo_url_light') || map.get('logo_url') || null) as string | null,
      // The invoice background style is saved under `invoice_bg_style`
      // (`invoice_bg_design` was a legacy/never-saved key). Report uses the
      // same setting as the invoice so they match.
      bgDesign: (map.get('invoice_bg_style') || map.get('invoice_bg_design')) as string | undefined,
      bgTopUrl: map.get('invoice_bg_image_top_url') as string | undefined,
      bgBottomUrl: map.get('invoice_bg_image_bottom_url') as string | undefined,
    }
  } catch {
    return { logoUrl: null }
  }
}

/**
 * Upserts branding config for a client.
 */
export async function saveBrandConfig(
  clientId: string,
  config: Partial<BrandConfig>,
): Promise<void> {
  const admin = createAdminClient()
  await admin.from('client_branding').upsert(
    {
      client_id: clientId,
      agency_name: config.agencyName,
      client_name: config.clientName,
      primary_color: config.primaryColor,
      secondary_color: config.secondaryColor,
      accent_color: config.accentColor,
      logo_url: config.logoUrl,
      agency_logo_url: config.agencyLogoUrl,
      contact_phone: config.contactPhone,
      contact_email: config.contactEmail,
      contact_website: config.contactWebsite,
      footer_text: config.footerText,
      white_label_mode: config.whiteLabelMode,
      confidential_watermark: config.confidentialWatermark,
      show_powered_by: config.showPoweredBy,
    },
    { onConflict: 'client_id' },
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mapRowToBrandConfig(row: any, fallbackClientName: string): BrandConfig {
  return {
    agencyName:           row.agency_name ?? CIRQLE_DEFAULTS.agencyName,
    clientName:           row.client_name ?? fallbackClientName,
    primaryColor:         row.primary_color ?? CIRQLE_DEFAULTS.primaryColor,
    secondaryColor:       row.secondary_color ?? CIRQLE_DEFAULTS.secondaryColor,
    accentColor:          row.accent_color ?? CIRQLE_DEFAULTS.accentColor,
    logoUrl:              row.logo_url ?? null,
    agencyLogoUrl:        row.agency_logo_url ?? CIRQLE_DEFAULTS.agencyLogoUrl,
    contactPhone:         row.contact_phone ?? CIRQLE_DEFAULTS.contactPhone,
    contactEmail:         row.contact_email ?? CIRQLE_DEFAULTS.contactEmail,
    contactWebsite:       row.contact_website ?? CIRQLE_DEFAULTS.contactWebsite,
    footerText:           row.footer_text ?? CIRQLE_DEFAULTS.footerText,
    whiteLabelMode:       (row.white_label_mode as WhiteLabelMode) ?? 'cirqle',
    confidentialWatermark: row.confidential_watermark ?? false,
    showPoweredBy:        row.show_powered_by ?? CIRQLE_DEFAULTS.showPoweredBy,
  }
}

function buildDefaultBrandConfig(clientName: string): BrandConfig {
  return {
    agencyName:           CIRQLE_DEFAULTS.agencyName,
    clientName,
    primaryColor:         CIRQLE_DEFAULTS.primaryColor,
    secondaryColor:       CIRQLE_DEFAULTS.secondaryColor,
    accentColor:          CIRQLE_DEFAULTS.accentColor,
    logoUrl:              null,
    agencyLogoUrl:        CIRQLE_DEFAULTS.agencyLogoUrl,
    contactPhone:         CIRQLE_DEFAULTS.contactPhone,
    contactEmail:         CIRQLE_DEFAULTS.contactEmail,
    contactWebsite:       CIRQLE_DEFAULTS.contactWebsite,
    footerText:           null,
    whiteLabelMode:       'cirqle',
    confidentialWatermark: false,
    showPoweredBy:        true,
  }
}
