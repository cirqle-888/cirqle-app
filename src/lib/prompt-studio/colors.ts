/**
 * Prompt Studio — brand colours.
 *
 * A Client Card holds the brand's colours as text ("Maroon #7A1F2B, gold
 * #D4A64A"). This turns them into one plain rule for the AI, in one of three
 * ways the client may ask for:
 *
 *   exact     only the brand colours
 *   accents   neutral backgrounds, brand colours as accents
 *   matching  a palette that pairs with the brand, not the exact colours
 *
 * The matching palette is worked out from the first brand colour by fixed
 * rules, so the same client always gets the same palette and the feed does not
 * fill up with a new set of colours in every post.
 */

export const COLOR_USE_OPTIONS = [
  'Exact brand colours only',
  'Brand colours as accents on neutral backgrounds',
  'Matching colours that pair with the brand',
] as const
export type ColorUse = typeof COLOR_USE_OPTIONS[number]

const HEX = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g

/** Every hex colour in a text, as #RRGGBB, in order, without repeats (six at most). */
export function hexesIn(text: string | null | undefined): string[] {
  const out: string[] = []
  for (const m of (text ?? '').matchAll(HEX)) {
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1]
    const hex = `#${h.toUpperCase()}`
    if (!out.includes(hex)) out.push(hex)
  }
  return out.slice(0, 6)
}

/** #RRGGBB → hue 0–360, saturation and lightness 0–100. */
export function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  if (!d) return [0, 0, Math.round(l * 100)]
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [Math.round((h * 60 + 360) % 360), Math.round(s * 100), Math.round(l * 100)]
}

export function hslToHex(h: number, s: number, l: number): string {
  const S = Math.min(100, Math.max(0, s)) / 100, L = Math.min(100, Math.max(0, l)) / 100
  const c = (1 - Math.abs(2 * L - 1)) * S, hp = (((h % 360) + 360) % 360) / 60, x = c * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = L - c / 2
  return `#${[r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}

export interface PairingPalette {
  /** The brand's first colour, as given. */
  main: string
  /** Very light tint of the main colour, for backgrounds. */
  light: string
  /** Soft mid tint, for panels and shapes. */
  soft: string
  /** Deep shade, for text and footers. */
  dark: string
  /** Off-white with a hint of the brand hue. */
  neutral: string
  /** The brand's second colour, or a calm neighbour of the main one. */
  accent: string
}

/** Colours that sit well with the brand: tints and shades of its main colour, a tinted neutral and one accent. */
export function pairingPalette(hexes: string[]): PairingPalette | null {
  if (!hexes.length) return null
  const [h, s] = hexToHsl(hexes[0])
  return {
    main: hexes[0],
    light: hslToHex(h, Math.min(s, 45), 94),
    soft: hslToHex(h, Math.min(s, 50), 82),
    dark: hslToHex(h, Math.min(Math.max(s, 25), 60), 18),
    neutral: hslToHex(h, Math.min(s, 12), 97),
    accent: hexes[1] ?? hslToHex(h + 30, Math.min(Math.max(s, 35), 60), 48),
  }
}

/** The colours a creative may use under each rule, for the swatches on the card. */
export function swatches(colors: string | null | undefined, use: string | null | undefined): string[] {
  const hexes = hexesIn(colors)
  const p = pairingPalette(hexes)
  if (!p) return []
  if (use === COLOR_USE_OPTIONS[1]) return [p.neutral, p.dark, ...hexes]
  if (use === COLOR_USE_OPTIONS[2]) return [p.light, p.soft, p.main, p.dark, p.neutral, p.accent]
  return hexes
}

const LIMIT = 'Use the same colours in every post so the feed looks like one brand.'

/** One line telling the AI how to use colour. Empty when no rule was chosen. */
export function colourRule(colors: string | null | undefined, use: string | null | undefined): string {
  if (!use || !(COLOR_USE_OPTIONS as readonly string[]).includes(use)) return ''
  const hexes = hexesIn(colors)
  const p = pairingPalette(hexes)
  const brand = hexes.length ? hexes.join(', ') : 'the brand colours listed above'
  if (use === COLOR_USE_OPTIONS[0])
    return `Colour rule: use only ${brand}, plus white and black. The first colour leads (about 60% of the design), the next supports, the last is a small accent. No other colours. ${LIMIT}`
  if (use === COLOR_USE_OPTIONS[1])
    return `Colour rule: backgrounds stay neutral (${p ? `${p.neutral} or white` : 'white or a soft off-white'}), body text ${p ? p.dark : 'dark'}. Use ${brand} only as accents: headline, price tag, button, border. At most 3 colours in one design. ${LIMIT}`
  return `Colour rule: the exact brand colours are not required. Use this matching palette instead${p ? `: background ${p.light} or ${p.neutral}, shapes ${p.soft}, main ${p.main}, text ${p.dark}, one accent ${p.accent}` : ': tints and shades of the main brand colour, a soft neutral and one accent'}. At most 3 colours plus the neutral in one design. Keep the logo in its own colours. ${LIMIT}`
}
