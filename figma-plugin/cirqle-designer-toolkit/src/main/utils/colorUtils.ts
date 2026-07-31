/** Colour math shared by the Accessibility Checker and Design QA modules.
 * Pure functions, no Figma API dependency, so they're unit-testable in
 * isolation (see src/main/utils/colorUtils.test.ts). */

export interface RGB { r: number; g: number; b: number; }

export function figmaColorToRgb255(color: RGBA | RGB): RGB {
  return { r: Math.round(color.r * 255), g: Math.round(color.g * 255), b: Math.round(color.b * 255) };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** WCAG relative luminance, per https://www.w3.org/TR/WCAG21/#dfn-relative-luminance */
export function relativeLuminance({ r, g, b }: RGB): number {
  const srgb = [r, g, b].map((c) => c / 255);
  const lin = srgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

export type WcagLevel = 'fail' | 'AA' | 'AAA';

/** WCAG 2.1 SC 1.4.3 / 1.4.6 thresholds. `isLargeText` = >=18pt, or >=14pt bold. */
export function wcagLevel(ratio: number, isLargeText: boolean): WcagLevel {
  if (isLargeText) {
    if (ratio >= 4.5) return 'AAA';
    if (ratio >= 3) return 'AA';
    return 'fail';
  }
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  return 'fail';
}

export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  // 18pt ~= 24px, 14pt ~= 18.66px. Figma reports px directly.
  if (fontSizePx >= 24) return true;
  if (fontSizePx >= 18.66 && fontWeight >= 700) return true;
  return false;
}

/**
 * Colour-blindness simulation matrices (Brettel/Viénot–style linear
 * approximations, the same class of matrix widely used by browser
 * devtools' "Emulate vision deficiencies"). Applied in linear RGB space.
 * This simulates the *colour values* the plugin can read (fills, strokes,
 * text colour) — it cannot filter Figma's live canvas rendering, since the
 * Plugin API has no access to pixel output. See docs/MODULES.md for that
 * limitation stated plainly.
 */
const CVD_MATRICES: Record<'protanopia' | 'deuteranopia' | 'tritanopia', number[][]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia' | 'achromatopsia';

export function simulateColorBlindness(rgb: RGB, type: CvdType): RGB {
  if (type === 'achromatopsia') {
    // Full colour blindness ≈ perceived-luminance grayscale.
    const gray = Math.round(0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b);
    return { r: gray, g: gray, b: gray };
  }

  const matrix = CVD_MATRICES[type];
  const lin = [srgbToLinear(rgb.r), srgbToLinear(rgb.g), srgbToLinear(rgb.b)];
  const out = matrix.map((row) => row[0]! * lin[0]! + row[1]! * lin[1]! + row[2]! * lin[2]!);
  return { r: linearToSrgb(out[0]!), g: linearToSrgb(out[1]!), b: linearToSrgb(out[2]!) };
}
