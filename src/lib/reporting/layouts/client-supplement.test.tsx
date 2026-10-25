import { describe, expect, it } from 'vitest'
import { supplementElements } from './client-supplement'
import type { RenderData } from '../types'
import { getReportFonts } from './fonts'
import { ImageResponse } from 'next/og'
import { writeFileSync } from 'node:fs'
const fixture = {
  config: { language: 'ml', dateFrom: '2026-10-01', dateTo: '2026-10-24' },
  project: { clientName: 'Fixture supermarket' },
  ai: { executiveSummary: 'പരസ്യത്തിനായി ₹500 ചെലവായി. ലീഡുകൾ: 10. ഒരു ഫലത്തിനുള്ള പരസ്യച്ചെലവ് ₹50 ആണ്. അടുത്ത നടപടി: ഫലങ്ങൾ പരിശോധിച്ച് അടുത്ത ക്യാമ്പെയ്ൻ അപ്ഡേറ്റ് തീരുമാനിക്കുക.' },
  campaigns: Array.from({ length: 9 }, (_, i) => ({ projectId: String(i), campaignName: `Campaign ${i + 1}`, resultLabel: 'Conversations', costLabel: 'Cost per conversation', results: 10, costPerResult: 50, spend: 500 })),
} as unknown as RenderData

describe('client report supplement pages', () => {
  it('paginates all campaigns without dropping the Malayalam summary', () => expect(supplementElements(fixture, 1240, 1754)).toHaveLength(4))
  it.skipIf(process.env.REPORT_VISUAL_QA !== '1')('renders representative local PNGs for visual verification', async () => {
    const pages = supplementElements(fixture, 1240, 1754)
    for (let i = 0; i < 2; i++) {
      const result = new ImageResponse(pages[i], { width: 1240, height: 1754, fonts: getReportFonts() })
      const png = Buffer.from(await result.arrayBuffer())
      expect(png.length).toBeGreaterThan(10000)
      writeFileSync(`/tmp/cirqle-report-supplement-${i}.png`, png)
    }
  }, 60000)
})
