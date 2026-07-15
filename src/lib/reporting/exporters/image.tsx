/**
 * Image Exporter (WhatsApp-ready PNG)
 *
 * Generates PNG images using Next.js's bundled ImageResponse (@vercel/og).
 * Two sizes: portrait (1080×1920) and square (1080×1080).
 *
 * Every template renders through the same branded visual system — Daily and
 * Monthly use their own day/month-table layout; the other six templates use
 * the "cards" layout — dispatched via `IMAGE_BUILDERS` in ../layouts/registry
 * so image + PDF always agree on which builder a template uses.
 */

import { ImageResponse } from 'next/og'
import type { RenderData } from '../types'
import { IMAGE_BUILDERS } from '../layouts/registry'
import { getReportFonts } from '../layouts/fonts'

/**
 * Generates a portrait PNG (1080×1920) — WhatsApp story / full-screen.
 */
export async function generateImagePortrait(data: RenderData): Promise<Buffer> {
  return generateImage(data, 1080, 1920)
}

/**
 * Generates a square PNG (1080×1080) — WhatsApp post / Instagram.
 */
export async function generateImageSquare(data: RenderData): Promise<Buffer> {
  return generateImage(data, 1080, 1080)
}

// ─── Core dispatcher ──────────────────────────────────────────────────────────

async function generateImage(data: RenderData, width: number, height: number): Promise<Buffer> {
  const fonts = getReportFonts()
  const build = IMAGE_BUILDERS[data.template.name]
  const element = await build(data, { width, height, fonts })

  const response = new ImageResponse(element, { width, height, fonts })
  const arrayBuffer = await (response as Response).arrayBuffer()
  return Buffer.from(arrayBuffer)
}
