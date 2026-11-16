'use client'

import { useEffect, useId, type RefObject } from 'react'

/**
 * Edge refraction for a `liquid-glass` surface — the "liquid" part of Liquid Glass.
 *
 * The `liquid-glass` utility in globals.css already gives every browser a frosted,
 * tinted layer. This hook adds what CSS alone cannot: content behind the
 * surface bends near its edges, the way a thick lens would. It does that by
 * building a displacement map the size of the element (red = push sideways,
 * green = push vertically, strongest at the rim, nothing in the middle) and
 * pointing the element's backdrop-filter at an SVG filter that blurs,
 * saturates and then displaces the backdrop through that map.
 *
 * Chromium only (Chrome, Edge, Electron, Android WebView): Safari and Firefox
 * do not run SVG filters inside backdrop-filter, so there the hook does
 * nothing and the plain frosted glass stays. It also stays off when the
 * person has asked for reduced transparency or more contrast.
 *
 * The map is rebuilt when the element changes size, at most once a frame.
 * The element's corner radius is read from its computed style, so the bend
 * follows rounded corners without being told about them.
 */

export interface LiquidGlassOptions {
  /** Width of the bending band along each edge, in px. */
  bezel?: number
  /** Largest shift at the very rim, in px. */
  strength?: number
  /** Backdrop blur in px (same meaning as CSS blur()) — keep it equal to the
   *  surface's --glass-blur so browsers with and without refraction match. */
  blur?: number
  /** Backdrop saturation, 1 = unchanged. */
  saturate?: number
  enabled?: boolean
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function canRefract(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (window.matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)').matches) return false
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
    .userAgentData?.brands
  if (brands) return brands.some(b => b.brand === 'Chromium')
  // No Client Hints (older Chromium): fall back to the UA string. Chrome and
  // Edge on iOS are WebKit underneath, so they are excluded.
  const ua = navigator.userAgent
  return /Chrome\/|Chromium\//.test(ua) && !/CriOS|EdgiOS|FxiOS/.test(ua)
}

/** Displacement map for a rounded rectangle, as a PNG data URL. */
function buildMap(w: number, h: number, radius: number, bezel: number): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(w, h)
  const data = img.data
  const r = Math.min(radius, w / 2, h / 2)
  const hx = w / 2 - r
  const hy = h / 2 - r
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - h / 2
    const qy = Math.abs(dy) - hy
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const dx = x + 0.5 - w / 2
      const qx = Math.abs(dx) - hx
      // Signed distance to the rounded rectangle's outline (negative inside).
      const ox = Math.max(qx, 0)
      const oy = Math.max(qy, 0)
      const outside = Math.hypot(ox, oy)
      const depth = -(outside + Math.min(Math.max(qx, qy), 0) - r)
      let nx = 0
      let ny = 0
      if (depth >= 0 && depth < bezel) {
        // Inward normal of the nearest edge (or corner arc).
        if (ox > 0 && oy > 0) {
          nx = -(ox / outside) * Math.sign(dx)
          ny = -(oy / outside) * Math.sign(dy)
        } else if (qx > qy) {
          nx = -Math.sign(dx)
        } else {
          ny = -Math.sign(dy)
        }
        // Strongest at the rim, easing to nothing at the inner edge of the
        // band — the profile of a rounded slab of glass.
        const t = 1 - depth / bezel
        const m = t * t
        nx *= m
        ny *= m
      }
      data[i] = Math.round(128 + nx * 127)
      data[i + 1] = Math.round(128 + ny * 127)
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

export function useLiquidGlass(
  ref: RefObject<HTMLElement | null>,
  { bezel = 14, strength = 18, blur = 10, saturate = 1.8, enabled = true }: LiquidGlassOptions = {},
) {
  const rawId = useId()
  const filterId = `liquid-glass-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled || !canRefract()) return

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.style.pointerEvents = 'none'

    const filter = document.createElementNS(SVG_NS, 'filter')
    filter.id = filterId
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    filter.setAttribute('filterUnits', 'userSpaceOnUse')
    filter.setAttribute('primitiveUnits', 'userSpaceOnUse')
    filter.setAttribute('x', '0')
    filter.setAttribute('y', '0')

    const blurEl = document.createElementNS(SVG_NS, 'feGaussianBlur')
    blurEl.setAttribute('in', 'SourceGraphic')
    // CSS blur(r) and stdDeviation are the same quantity.
    blurEl.setAttribute('stdDeviation', String(blur))
    blurEl.setAttribute('edgeMode', 'duplicate')
    blurEl.setAttribute('result', 'blurred')

    const sat = document.createElementNS(SVG_NS, 'feColorMatrix')
    sat.setAttribute('in', 'blurred')
    sat.setAttribute('type', 'saturate')
    sat.setAttribute('values', String(saturate))
    sat.setAttribute('result', 'tinted')

    const map = document.createElementNS(SVG_NS, 'feImage')
    map.setAttribute('x', '0')
    map.setAttribute('y', '0')
    map.setAttribute('preserveAspectRatio', 'none')
    map.setAttribute('result', 'map')

    const displace = document.createElementNS(SVG_NS, 'feDisplacementMap')
    displace.setAttribute('in', 'tinted')
    displace.setAttribute('in2', 'map')
    // The map stores ±1 as 128±127, and the filter shifts by scale × (v − 0.5),
    // so scale = 2 × strength gives `strength` px at the rim.
    displace.setAttribute('scale', String(strength * 2))
    displace.setAttribute('xChannelSelector', 'R')
    displace.setAttribute('yChannelSelector', 'G')

    filter.append(blurEl, sat, map, displace)
    svg.append(filter)
    document.body.append(svg)

    let lastW = 0
    let lastH = 0
    let lastR = -1
    let frame = 0
    let applied = false

    const update = () => {
      frame = 0
      const w = Math.round(el.offsetWidth)
      const h = Math.round(el.offsetHeight)
      // display:none (e.g. the bottom nav on desktop): nothing to build.
      if (w < 2 || h < 2) return
      const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
      if (w === lastW && h === lastH && radius === lastR) return
      const url = buildMap(w, h, radius, Math.min(bezel, w / 2, h / 2))
      if (!url) return
      lastW = w
      lastH = h
      lastR = radius
      for (const node of [filter, map]) {
        node.setAttribute('width', String(w))
        node.setAttribute('height', String(h))
      }
      map.setAttribute('href', url)
      if (!applied) {
        el.style.setProperty('--glass-filter', `url(#${filterId})`)
        applied = true
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }

    update()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)

    // Turning on reduced transparency or more contrast mid-session drops the
    // refraction straight away; the CSS falls back to a solid surface.
    const mq = window.matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)')
    const onPref = () => {
      if (mq.matches) el.style.removeProperty('--glass-filter')
      else if (applied) el.style.setProperty('--glass-filter', `url(#${filterId})`)
    }
    mq.addEventListener('change', onPref)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      mq.removeEventListener('change', onPref)
      el.style.removeProperty('--glass-filter')
      svg.remove()
    }
  }, [ref, filterId, bezel, strength, blur, saturate, enabled])
}
