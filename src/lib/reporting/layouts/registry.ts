/**
 * Central layout dispatch — maps each `ReportTemplate` to the visual system
 * it renders through. Two "kinds" today:
 *
 *   'daily-style' — a paginated day/month-by-day table with a full hero
 *                    (Daily, Monthly). Rendered by the generic
 *                    `generatePagedRasterPDF` helper in exporters/pdf.ts.
 *   'cards-style' — content "cards" (executive summary, KPI scorecard,
 *                    forecasts, AI insights, etc) driven by the template's
 *                    `sections` config (Performance, Executive, Marketing,
 *                    Lead Gen, E-commerce, Agency). Rendered by
 *                    `generateCardsStylePDF`.
 *
 * Adding a new template: add it to `ReportTemplate` (types.ts), give it a
 * `TEMPLATE_CONFIGS` entry (template-engine.ts), then register it in
 * `LAYOUT_KIND` + `IMAGE_BUILDERS` here.
 */

import type { RenderData, ReportTemplate } from '../types'
import { buildDailyReportElement } from './daily-report'
import { buildMonthlyReportElement } from './monthly-report'
import { buildCardsReportElement } from './report-cards'
import type { ReportFont } from './measure'

export type LayoutKind = 'daily-style' | 'cards-style'

export const LAYOUT_KIND: Record<ReportTemplate, LayoutKind> = {
  daily: 'daily-style',
  monthly: 'daily-style',
  performance: 'cards-style',
  executive: 'cards-style',
  marketing: 'cards-style',
  lead_gen: 'cards-style',
  ecommerce: 'cards-style',
  agency: 'cards-style',
}

interface ImageLayoutOpts { width: number; height: number; fonts: ReportFont[] }

/** Single-canvas builders for the WhatsApp/PNG image exporter, one per
 * template. Cards-style templates measure their content for real (async);
 * daily-style ones just assemble already-decided rows (sync) — the shared
 * `Promise<React.ReactElement>` return type lets `image.tsx` `await` both
 * uniformly without per-template branching. */
export const IMAGE_BUILDERS: Record<ReportTemplate, (data: RenderData, opts: ImageLayoutOpts) => React.ReactElement | Promise<React.ReactElement>> = {
  daily: (data, opts) => buildDailyReportElement(data, opts),
  monthly: (data, opts) => buildMonthlyReportElement(data, opts),
  performance: buildCardsReportElement,
  executive: buildCardsReportElement,
  marketing: buildCardsReportElement,
  lead_gen: buildCardsReportElement,
  ecommerce: buildCardsReportElement,
  agency: buildCardsReportElement,
}
