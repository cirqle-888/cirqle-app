// Draws the Android launch screen artwork from the brand mark.
// Run from the repo root:  node mobile/scripts/generate-splash.mjs
// Uses `sharp` (a Next.js dependency). Outputs are committed; rerun after a
// brand change, then rebuild (scripts/build-android.sh copies them in).
//
// The launch screen is three pieces, none of which Android ever stretches:
//   * a solid colour (white by day, the app's #0b0f1a at night),
//   * the logo, drawn at its own size in the centre (cirqle_splash_icon),
//   * on Android 12+, a wordmark strip at the bottom (cirqle_splash_branding).
//
// It also rewrites mobile/assets/splash*.png — the full-screen image the
// splash plugin falls back to. That one is centre-CROPPED to the screen
// (androidScaleType CENTER_CROP), so the logo sits in the middle with plenty of
// plain colour around it and can never be cut or distorted.
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const MARK = 'mobile/assets/icon-foreground.png'   // 1024², mark on a white disc, transparent outside
const OUT = 'mobile/native/android/res'
const LIGHT_BG = '#ffffff'
const DARK_BG = '#0b0f1a'
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 }

// The disc has a hairline grey edge that reads as a stray ring on a white
// screen. Clip just inside it: on white the disc disappears and only the mark
// shows; on the dark screen it stays as a clean white badge.
async function badge(size) {
  const trimmed = await sharp(MARK).trim().png().toBuffer()
  const disc = await sharp(trimmed).resize(size, size).png().toBuffer()
  const r = size / 2
  const mask = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r - Math.max(2, size * 0.006)}" fill="#fff"/></svg>`)
  return sharp(disc).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
}

const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
const made = []

for (const [name, scale] of Object.entries(DENSITIES)) {
  // Splash icon: a 288dp canvas of which Android shows the middle 192dp circle.
  // The badge is 168dp so it sits inside that circle with room to spare.
  const canvas = Math.round(288 * scale)
  const logo = await badge(Math.round(168 * scale))
  const dir = `${OUT}/drawable-${name}`
  await mkdir(dir, { recursive: true })
  await sharp({ create: { width: canvas, height: canvas, channels: 4, background: CLEAR } })
    .composite([{ input: logo, gravity: 'centre' }])
    .png().toFile(`${dir}/cirqle_splash_icon.png`)
  made.push(`${dir}/cirqle_splash_icon.png`)

  // Wordmark strip: 200 × 80 dp, light and night.
  const w = Math.round(200 * scale), h = Math.round(80 * scale)
  for (const [night, ink, sub] of [[false, '#0b0f1a', '#6b7280'], [true, '#ffffff', '#9aa3b2']]) {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 200 80">
      <text x="100" y="38" text-anchor="middle" font-family="Inter, Helvetica Neue, Arial, sans-serif"
            font-size="24" font-weight="600" letter-spacing="-0.6" fill="${ink}">Cirqle</text>
      <text x="100" y="58" text-anchor="middle" font-family="Inter, Helvetica Neue, Arial, sans-serif"
            font-size="8.5" font-weight="500" letter-spacing="2.4" fill="${sub}">BUSINESS MANAGEMENT</text>
    </svg>`)
    const d = `${OUT}/drawable${night ? '-night' : ''}-${name}`
    await mkdir(d, { recursive: true })
    await sharp(svg).png().toFile(`${d}/cirqle_splash_branding.png`)
    made.push(`${d}/cirqle_splash_branding.png`)
  }
}

// Fallback full-screen splash sources for @capacitor/assets (centre-cropped).
for (const [file, bg] of [['mobile/assets/splash.png', LIGHT_BG], ['mobile/assets/splash-dark.png', DARK_BG]]) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: bg } })
    .composite([{ input: await badge(520), gravity: 'centre' }])
    .png().toFile(file)
  made.push(file)
}

console.log(`✓ ${made.length} files written`)
