// Regenerate all mobile/PWA icons + splash from the master brand mark.
// Run from the repo root:  node mobile/scripts/generate-icons.mjs
// Uses `sharp` (a Next.js dependency). Source of truth: desktop/assets/icon.png
// (1024² Cirqle mark on a white disc). Outputs are committed; rerun after a
// brand change. No layout/logic touched — this only writes image files.
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const SRC = 'desktop/assets/icon.png'
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }
const DARK  = { r: 11, g: 15, b: 26, alpha: 1 }   // #0b0f1a — app dark bg
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 }

const srcBuf = await sharp(SRC).png().toBuffer()

// Compose the logo at `scale` of the canvas, centered on `bg`.
async function compose(size, bg, scale, out) {
  const inner = Math.round(size * scale)
  const logo = await sharp(srcBuf)
    .resize(inner, inner, { fit: 'contain', background: CLEAR })
    .png().toBuffer()
  await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: logo, gravity: 'centre' }])
    .png().toFile(out)
  return out
}

await mkdir('public/icons', { recursive: true })
await mkdir('mobile/assets', { recursive: true })

const made = []
// PWA icons (referenced by app/manifest.ts)
made.push(await compose(192, WHITE, 0.92, 'public/icons/icon-192.png'))
made.push(await compose(512, WHITE, 0.92, 'public/icons/icon-512.png'))
// Maskable: shrink into the inner ~72% safe zone so launcher masks never clip.
made.push(await compose(512, WHITE, 0.72, 'public/icons/maskable-512.png'))
// iOS home-screen icon (no transparency; iOS rounds the corners itself).
made.push(await compose(180, WHITE, 0.92, 'src/app/apple-icon.png'))

// @capacitor/assets source images (fanned out into android/ at build time)
made.push(await compose(1024, WHITE, 0.92, 'mobile/assets/icon-only.png'))
made.push(await compose(1024, CLEAR, 0.66, 'mobile/assets/icon-foreground.png'))
made.push(await compose(1024, WHITE, 1.0,  'mobile/assets/icon-background.png'))
made.push(await compose(2732, WHITE, 0.19, 'mobile/assets/splash.png'))
made.push(await compose(2732, DARK,  0.19, 'mobile/assets/splash-dark.png'))

for (const f of made) {
  const m = await sharp(f).metadata()
  console.log(`  ${f}  ${m.width}x${m.height}`)
}
console.log('done:', made.length, 'files')
