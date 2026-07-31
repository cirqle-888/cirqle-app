/**
 * Accessibility Checker scan logic. Runs entirely on the main thread (Figma
 * sandbox) — no DOM, no jsPDF here (see runtime boundary note in
 * src/ui/lib/report/pdfReport.ts). Every heavy loop goes through
 * processInChunks so a large file doesn't freeze Figma's UI thread.
 *
 * IMPORTANT HONESTY NOTE (documented here, and again in the UI copy):
 * Figma's Plugin API has no real compositing/pixel-read access. There is no
 * way to ask "what colour is actually rendered behind this text node" —
 * blend modes, nested opacity, images, effects and overlapping siblings are
 * all invisible to us. What we do instead is a best-effort heuristic: walk
 * up the ancestor chain and use the nearest ancestor with a visible, ~opaque
 * SOLID fill as a stand-in "background", falling back to white if no such
 * ancestor exists. This is clearly an approximation and every contrast
 * finding computed against a *fallback* background is flagged as such
 * (see ContrastFinding via the underlying Issue's `meta.backgroundIsFallback`).
 * Likewise, the colour-blindness "swatches" simulate colour VALUES read from
 * fills/strokes — they are not a render filter over the live canvas.
 */
import type { Issue, NodeRef } from '@shared/types';
import { generateId } from '@shared/id';
import {
  figmaColorToRgb255,
  rgbToHex,
  contrastRatio,
  relativeLuminance,
  wcagLevel,
  isLargeText,
  simulateColorBlindness,
  type RGB,
} from '../../utils/colorUtils';
import { collectNodes, toNodeRef } from '../../utils/traversal';
import { processInChunks } from '../../utils/chunk';
import type { HandlerContext } from '../../bridge';
import type { A11yScanResult, ContrastFinding, FontSizeFinding, TouchTargetFinding, CvdSwatch } from './a11yTypes';

export type A11yScanScope = 'selection' | 'page';

/** Readability floor. Configurable — tune here if the brief changes. */
export const MIN_FONT_SIZE_PX = 12;

/** Minimum recommended tap target. 44px ≈ Apple iOS Human Interface
 * Guidelines; Material Design uses 48px. Default to the smaller (44px),
 * tune later if the toolkit wants a stricter Material-only mode. */
export const MIN_TOUCH_TARGET_PX = 44;

const TOUCH_TARGET_NAME_HINTS = ['button', 'btn', 'cta'];

/** How many distinct solid colours we'll bother simulating/returning — keeps
 * the UI swatch grid and the PDF export sane on files with huge palettes. */
const MAX_SWATCHES = 40;

const AA_RATIO_LARGE = 3;
const AA_RATIO_NORMAL = 4.5;
/** Caps the auto-fix search loop so a pathological input (e.g. two colours
 * that are already at opposite lightness extremes and still failing due to
 * hue) can't hang the scan. */
const MAX_FIX_ITERATIONS = 60;
const LIGHTNESS_STEP = 0.02;

export interface RunA11yScanOptions {
  scope: A11yScanScope;
  ctx: HandlerContext;
}

export async function runA11yScan({ scope, ctx }: RunA11yScanOptions): Promise<A11yScanResult> {
  ctx.reportProgress({ done: 0, total: 1, indeterminate: true, label: 'Collecting nodes…' });

  const nodes = await collectNodes(scope, () => true, {
    signal: ctx.signal,
    chunkSize: 250,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Collecting nodes…' }),
  });

  const textNodes = nodes.filter((n): n is TextNode => n.type === 'TEXT');
  const interactiveCandidates = nodes.filter(isInteractiveCandidate);

  const contrast: ContrastFinding[] = [];
  const fontSize: FontSizeFinding[] = [];
  const issues: Issue[] = [];
  const colourMap = new Map<string, RGB>();

  await processInChunks(
    textNodes,
    (node) => {
      processTextNode(node, contrast, fontSize, issues, colourMap);
    },
    {
      signal: ctx.signal,
      onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Scanning text nodes…' }),
    }
  );

  const touchTargets: TouchTargetFinding[] = [];
  await processInChunks(
    interactiveCandidates,
    (node) => {
      processInteractiveNode(node, touchTargets, issues);
    },
    {
      signal: ctx.signal,
      onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Checking touch targets…' }),
    }
  );

  // Second colour pass across *every* scanned node's fills/strokes (not just
  // text) so the colour-blindness grid reflects the whole palette in scope,
  // not just text colours.
  await processInChunks(
    nodes,
    (node) => {
      collectDistinctColours(node, colourMap);
    },
    { signal: ctx.signal }
  );

  const swatches: CvdSwatch[] = Array.from(colourMap.values())
    .slice(0, MAX_SWATCHES)
    .map(toSwatch);

  const score = computeScore(contrast, fontSize.length, textNodes.length, touchTargets.length, interactiveCandidates.length);

  return { score, contrast, fontSize, touchTargets, swatches, issues };
}

// ---------------------------------------------------------------------------
// Text node processing: font size + contrast
// ---------------------------------------------------------------------------

function processTextNode(
  node: TextNode,
  contrastOut: ContrastFinding[],
  fontOut: FontSizeFinding[],
  issuesOut: Issue[],
  colourMap: Map<string, RGB>
): void {
  const ref = toNodeRef(node);

  const { size: fontSizePx } = getDominantFontSize(node);
  if (fontSizePx < MIN_FONT_SIZE_PX) {
    fontOut.push({ nodeId: node.id, nodeName: node.name, fontSize: fontSizePx, minSize: MIN_FONT_SIZE_PX });
    issuesOut.push({
      id: generateId('issue'),
      ruleId: 'a11y.font-size',
      severity: 'warning',
      title: 'Font size below readability minimum',
      description: `"${node.name}" uses ${fontSizePx}px text, below the ${MIN_FONT_SIZE_PX}px readability floor.`,
      node: ref,
      autoFixable: false,
    });
  }

  const fills = node.fills;
  if (fills === figma.mixed) {
    issuesOut.push(cannotDetermineIssue(ref, 'text has multiple fill colours across its range'));
    return;
  }
  const solidText = getSingleSolidFill(fills as Paint[]);
  if (!solidText) {
    issuesOut.push(cannotDetermineIssue(ref, 'text fill is not a single solid colour (gradient, image or multiple paints)'));
    return;
  }

  const textRgb = figmaColorToRgb255(solidText.color);
  const textHex = rgbToHex(textRgb);
  colourMap.set(textHex, textRgb);

  const bg = resolveBackground(node);
  colourMap.set(bg.hex, bg.rgb);

  const { weight } = getDominantFontWeight(node);
  const large = isLargeText(fontSizePx, weight);
  const ratio = contrastRatio(textRgb, bg.rgb);
  const level = wcagLevel(ratio, large);

  const finding: ContrastFinding = {
    nodeId: node.id,
    nodeName: node.name,
    textHex,
    backgroundHex: bg.hex,
    ratio: Math.round(ratio * 100) / 100,
    isLargeText: large,
    level,
  };

  if (level === 'fail') {
    finding.suggestion = suggestFix(textRgb, bg.rgb, large);
    issuesOut.push({
      id: generateId('issue'),
      ruleId: 'a11y.contrast',
      severity: 'error',
      title: 'Insufficient text contrast',
      description: bg.isFallback
        ? `"${node.name}" has a contrast ratio of ${finding.ratio}:1 against an assumed white background — no opaque ancestor fill was found, so this is an approximation.`
        : `"${node.name}" has a contrast ratio of ${finding.ratio}:1 against its nearest solid ancestor background, below the WCAG AA threshold for ${large ? 'large' : 'normal'} text.`,
      node: ref,
      autoFixable: Boolean(finding.suggestion),
      meta: { backgroundIsFallback: bg.isFallback, backgroundNodeId: bg.nodeId ?? null, ratio: finding.ratio },
    });
  }

  contrastOut.push(finding);
}

function cannotDetermineIssue(ref: NodeRef, reason: string): Issue {
  return {
    id: generateId('issue'),
    ruleId: 'a11y.cannot-determine',
    severity: 'info',
    title: 'Contrast could not be determined',
    description: `"${ref.name}": ${reason}, so contrast could not be determined.`,
    node: ref,
    autoFixable: false,
  };
}

// ---------------------------------------------------------------------------
// Font size / weight reading, incl. figma.mixed handling
// ---------------------------------------------------------------------------

/** Figma reports `fontSize` as `figma.mixed` when a text node has more than
 * one size across its character range. Per the brief, we use the "dominant"
 * size — here, the styled-text segment covering the most characters — rather
 * than skip entirely, since `getStyledTextSegments` makes that cheap. */
function getDominantFontSize(node: TextNode): { size: number; approximate: boolean } {
  if (node.fontSize !== figma.mixed) {
    return { size: node.fontSize, approximate: false };
  }
  const segments = node.getStyledTextSegments(['fontSize']);
  if (segments.length === 0) return { size: MIN_FONT_SIZE_PX, approximate: true };
  let dominant = segments[0]!;
  for (const seg of segments) {
    if (seg.characters.length > dominant.characters.length) dominant = seg;
  }
  return { size: dominant.fontSize, approximate: true };
}

/**
 * KNOWN UNCERTAINTY: the Figma Plugin API's primary way to read font
 * "weight" is `TextNode.fontName.style`, a free-text string like "Bold" or
 * "Semi Bold Italic" — there's no guarantee of a numeric field. Some newer
 * editor/typings versions are believed to also expose a numeric
 * `fontWeight` (variable font weight axis) directly on the node/segment; we
 * duck-type-check for it and prefer it when present, otherwise we parse the
 * style string. This dual path was NOT verified against installed
 * @figma/plugin-typings (none were available in this environment) — treat
 * the numeric branch as speculative and re-verify once typings are
 * installed; the string-parsing fallback is the safe baseline either way.
 */
function getDominantFontWeight(node: TextNode): { weight: number; approximate: boolean } {
  const numericWeight = readNumericFontWeight(node);
  if (numericWeight !== null) return { weight: numericWeight, approximate: false };

  if (node.fontName !== figma.mixed) {
    return { weight: styleToWeight(node.fontName.style), approximate: false };
  }
  const segments = node.getStyledTextSegments(['fontName']);
  if (segments.length === 0) return { weight: 400, approximate: true };
  let dominant = segments[0]!;
  for (const seg of segments) {
    if (seg.characters.length > dominant.characters.length) dominant = seg;
  }
  return { weight: styleToWeight(dominant.fontName.style), approximate: true };
}

function readNumericFontWeight(node: TextNode): number | null {
  const maybe = (node as unknown as { fontWeight?: unknown }).fontWeight;
  return typeof maybe === 'number' ? maybe : null;
}

function styleToWeight(style: string): number {
  const s = style.toLowerCase();
  if (s.includes('thin') || s.includes('hairline')) return 100;
  if (s.includes('extralight') || s.includes('extra light') || s.includes('ultralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('extrabold') || s.includes('extra bold') || s.includes('ultrabold')) return 800;
  if (s.includes('semibold') || s.includes('semi bold') || s.includes('demibold') || s.includes('demi bold')) return 600;
  if (s.includes('bold')) return 700;
  if (s.includes('medium')) return 500;
  return 400; // Regular / Book / Roman / anything unrecognised
}

// ---------------------------------------------------------------------------
// Background resolution (best-effort ancestor walk — see file header)
// ---------------------------------------------------------------------------

export interface ResolvedBackground {
  rgb: RGB;
  hex: string;
  isFallback: boolean;
  nodeId?: string;
}

export function resolveBackground(node: SceneNode): ResolvedBackground {
  const ancestor = findAncestorBackgroundNode(node);
  if (ancestor) {
    const paint = getOpaqueSolidPaint(ancestor);
    if (paint) {
      const rgb = figmaColorToRgb255(paint.color);
      return { rgb, hex: rgbToHex(rgb), isFallback: false, nodeId: ancestor.id };
    }
  }
  return { rgb: { r: 255, g: 255, b: 255 }, hex: '#FFFFFF', isFallback: true };
}

/** Walks up from `node`'s parent looking for the nearest ancestor with a
 * visible, ~opaque SOLID fill. Exported so index.ts's applyFix can target
 * the same node the scan used when the user picks the "background" fix. */
export function findAncestorBackgroundNode(node: SceneNode): SceneNode | null {
  let current: BaseNode | null = node.parent;
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if (getOpaqueSolidPaint(current as SceneNode)) return current as SceneNode;
    current = current.parent;
  }
  return null;
}

function getOpaqueSolidPaint(node: SceneNode): SolidPaint | null {
  if (!('fills' in node)) return null;
  const fills = (node as unknown as { fills?: Paint[] | symbol }).fills;
  if (!Array.isArray(fills)) return null;
  const nodeOpacity = 'opacity' in node ? (node as unknown as { opacity: number }).opacity : 1;
  // Paints render bottom→top in the array; the last visible opaque solid is
  // the one that would visually "win" as a flat background colour.
  for (let i = fills.length - 1; i >= 0; i -= 1) {
    const paint = fills[i]!;
    if (paint.type !== 'SOLID' || paint.visible === false) continue;
    const effectiveOpacity = (paint.opacity ?? 1) * (nodeOpacity ?? 1);
    if (effectiveOpacity >= 0.99) return paint;
  }
  return null;
}

function getSingleSolidFill(fills: Paint[]): SolidPaint | null {
  const visible = fills.filter((p) => p.visible !== false);
  if (visible.length !== 1) return null;
  const only = visible[0]!;
  return only.type === 'SOLID' ? only : null;
}

// ---------------------------------------------------------------------------
// Touch target check
// ---------------------------------------------------------------------------

function isInteractiveCandidate(node: SceneNode): boolean {
  if (node.type === 'INSTANCE') return true;
  const name = node.name.toLowerCase();
  return TOUCH_TARGET_NAME_HINTS.some((hint) => name.includes(hint));
}

function processInteractiveNode(node: SceneNode, out: TouchTargetFinding[], issuesOut: Issue[]): void {
  if (!('width' in node) || !('height' in node)) return;
  const w = (node as LayoutMixin & SceneNode).width;
  const h = (node as LayoutMixin & SceneNode).height;
  if (w >= MIN_TOUCH_TARGET_PX && h >= MIN_TOUCH_TARGET_PX) return;

  out.push({ nodeId: node.id, nodeName: node.name, width: w, height: h, minSize: MIN_TOUCH_TARGET_PX });
  issuesOut.push({
    id: generateId('issue'),
    ruleId: 'a11y.touch-target',
    severity: 'warning',
    title: 'Touch target smaller than recommended minimum',
    description: `"${node.name}" is ${Math.round(w)}×${Math.round(h)}px — below the ${MIN_TOUCH_TARGET_PX}px minimum recommended tap target (iOS HIG ≈44px, Material ≈48px).`,
    node: toNodeRef(node),
    autoFixable: false,
  });
}

// ---------------------------------------------------------------------------
// Colour-blindness swatches
// ---------------------------------------------------------------------------

function collectDistinctColours(node: SceneNode, out: Map<string, RGB>): void {
  collectSolidPaints(node, 'fills', out);
  collectSolidPaints(node, 'strokes', out);
}

function collectSolidPaints(node: SceneNode, key: 'fills' | 'strokes', out: Map<string, RGB>): void {
  if (!(key in node)) return;
  const paints = (node as unknown as Record<string, Paint[] | symbol | undefined>)[key];
  if (!Array.isArray(paints)) return;
  for (const paint of paints) {
    if (paint.type !== 'SOLID' || paint.visible === false) continue;
    const rgb = figmaColorToRgb255(paint.color);
    out.set(rgbToHex(rgb), rgb);
  }
}

function toSwatch(rgb: RGB): CvdSwatch {
  return {
    hex: rgbToHex(rgb),
    protanopia: rgbToHex(simulateColorBlindness(rgb, 'protanopia')),
    deuteranopia: rgbToHex(simulateColorBlindness(rgb, 'deuteranopia')),
    tritanopia: rgbToHex(simulateColorBlindness(rgb, 'tritanopia')),
    achromatopsia: rgbToHex(simulateColorBlindness(rgb, 'achromatopsia')),
  };
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * Composite 0-100 score:
 *   score = contrastPassRate * 0.50 + fontSizePassRate * 0.25 + touchTargetPassRate * 0.25
 * Each pass-rate is (checked - failed) / checked for that dimension; a
 * dimension with nothing to check (e.g. no interactive-looking nodes in
 * scope) counts as a full pass rather than penalising the score.
 */
function computeScore(
  contrast: ContrastFinding[],
  fontSizeFailCount: number,
  fontSizeTotal: number,
  touchTargetFailCount: number,
  touchTargetTotal: number
): number {
  const contrastChecked = contrast.length;
  const contrastPassed = contrast.filter((c) => c.level !== 'fail').length;
  const contrastScore = contrastChecked === 0 ? 1 : contrastPassed / contrastChecked;
  const fontScore = fontSizeTotal === 0 ? 1 : (fontSizeTotal - fontSizeFailCount) / fontSizeTotal;
  const touchScore = touchTargetTotal === 0 ? 1 : (touchTargetTotal - touchTargetFailCount) / touchTargetTotal;

  const composite = contrastScore * 0.5 + fontScore * 0.25 + touchScore * 0.25;
  return Math.round(composite * 100);
}

// ---------------------------------------------------------------------------
// Auto-fix suggestion search
// ---------------------------------------------------------------------------

function suggestFix(textRgb: RGB, bgRgb: RGB, isLarge: boolean): { field: 'text' | 'background'; hex: string } | undefined {
  const target = isLarge ? AA_RATIO_LARGE : AA_RATIO_NORMAL;

  // Prefer nudging whichever colour has more "room" to move — i.e. is
  // further from middle grey (L=0.5) — since it can travel further toward
  // black/white before clipping, and visually it's usually the one that
  // "reads" as already darker/lighter rather than the neutral one.
  const textRoom = Math.abs(rgbToHsl(textRgb).l - 0.5);
  const bgRoom = Math.abs(rgbToHsl(bgRgb).l - 0.5);
  const preferText = textRoom >= bgRoom;

  const primary = preferText ? nudgeForContrast(textRgb, bgRgb, target) : nudgeForContrast(bgRgb, textRgb, target);
  if (primary) return { field: preferText ? 'text' : 'background', hex: rgbToHex(primary) };

  // Preferred side couldn't reach the target within the iteration cap
  // (already near a lightness extreme) — try the other side before giving up.
  const secondary = preferText ? nudgeForContrast(bgRgb, textRgb, target) : nudgeForContrast(textRgb, bgRgb, target);
  if (secondary) return { field: preferText ? 'background' : 'text', hex: rgbToHex(secondary) };

  return undefined;
}

/** Nudges `moving`'s HSL lightness in small steps, away from `fixed`'s
 * luminance, re-testing contrastRatio each step, until the target ratio is
 * reached or the iteration cap / a lightness bound (0 or 1) is hit. */
function nudgeForContrast(moving: RGB, fixed: RGB, targetRatio: number): RGB | null {
  const startHsl = rgbToHsl(moving);
  const direction = relativeLuminance(moving) >= relativeLuminance(fixed) ? 1 : -1;
  let l = startHsl.l;

  for (let i = 0; i < MAX_FIX_ITERATIONS; i += 1) {
    l = clamp01(l + direction * LIGHTNESS_STEP);
    const candidate = hslToRgb({ h: startHsl.h, s: startHsl.s, l });
    if (contrastRatio(candidate, fixed) >= targetRatio) return candidate;
    if (l === 0 || l === 1) break;
  }
  return null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Minimal local HSL helpers (kept local to this module rather than added to
// the shared colorUtils.ts, which other modules also depend on — only the
// auto-fix search needs lightness nudging today).
// ---------------------------------------------------------------------------

interface HSL { h: number; s: number; l: number; }

function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return { h: 0, s: 0, l };

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;

  return { h, s, l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (h < 60) { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else { r1 = c; g1 = 0; b1 = x; }

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}
