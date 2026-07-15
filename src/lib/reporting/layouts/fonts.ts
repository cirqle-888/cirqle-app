/**
 * Local font bundle for the branded reporting engine.
 *
 * Neither `ImageResponse` call site previously passed a `fonts` option, so
 * Satori fell back to `next/og`'s default: a LIVE `fetch()` to Google Fonts
 * on every render (Latin coverage only, reliably) — a real latency/
 * reliability risk (network dependency mid-render, failures silently
 * swallowed by the vendor), and a hard failure for any non-Latin script:
 * Malayalam text didn't just overflow, it rendered as missing glyphs
 * ("tofu"), since no Malayalam-capable font was ever loaded.
 *
 * Fix: vendor Noto Sans (Latin) + Noto Sans Malayalam as local .ttf files
 * (OFL-licensed, downloaded from Google Fonts — see `src/lib/reporting/fonts/`),
 * loaded once and cached at module scope. Passed to EVERY `ImageResponse`
 * call AND to `measureElementHeight` — identical fonts everywhere guarantees
 * measured wrap points always match final render exactly. Satori auto-
 * detects script per text segment and picks the matching loaded family, so
 * plain JSX text needs no per-string font-family switching.
 */

import fs from 'fs'
import path from 'path'
import type { ReportFont } from './measure'

let cached: ReportFont[] | null = null

export function getReportFonts(): ReportFont[] {
  if (cached) return cached
  const dir = path.join(process.cwd(), 'src/lib/reporting/fonts')
  const load = (file: string) => fs.readFileSync(path.join(dir, file))
  cached = [
    { name: 'Noto Sans', data: load('NotoSans-Regular.ttf'), weight: 400, style: 'normal' },
    { name: 'Noto Sans', data: load('NotoSans-Bold.ttf'), weight: 700, style: 'normal' },
    { name: 'Noto Sans Malayalam', data: load('NotoSansMalayalam-Regular.ttf'), weight: 400, style: 'normal' },
    { name: 'Noto Sans Malayalam', data: load('NotoSansMalayalam-Bold.ttf'), weight: 700, style: 'normal' },
  ]
  return cached
}
