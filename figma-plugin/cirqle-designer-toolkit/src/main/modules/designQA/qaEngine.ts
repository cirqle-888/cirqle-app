/**
 * Design QA: a single chunked walk over the requested scope that gathers
 * candidates for every rule, followed by a handful of cheap post-walk
 * aggregate analyses (clustering/mode-finding) that need the whole
 * population before they can flag outliers. Every rule here is a
 * heuristic — none of them can know a designer's actual intent, so each
 * is commented with what it actually detects and where it can be wrong.
 */
import type { HandlerContext } from '../../bridge';
import { resolveScopeRoots, toNodeRef } from '../../utils/traversal';
import { yieldToEventLoop, processInChunksAsync } from '../../utils/chunk';
import { generateId } from '@shared/id';
import type { Issue, RunScope } from '@shared/types';
import { figmaColorToRgb255, rgbToHex, type RGB } from '../../utils/colorUtils';
import {
  RADIUS_TOLERANCE_PX,
  SPACING_TOLERANCE_PX,
  COLOR_CHANNEL_TOLERANCE,
  SHADOW_OFFSET_TOLERANCE_PX,
  SHADOW_BLUR_TOLERANCE_PX,
  SHADOW_SPREAD_TOLERANCE_PX,
  TYPOGRAPHY_SAMPLE_CAP,
  DUPLICATE_SAMPLE_CAP,
  MIN_AUTO_LAYOUT_CANDIDATE_CHILDREN,
  EVEN_SPACING_TOLERANCE_PX,
  MIN_SAMPLE_SIZE_FOR_CLUSTERING,
} from './designQATypes';

export interface DesignQAResult {
  scope: RunScope['scope'];
  scannedAt: number;
  issues: Issue[];
  summary: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Local structural type helpers (kept as inline casts rather than relying on
// exact @figma/plugin-typings mixin interface names, so a typings-version
// bump can't silently break this file).
// ---------------------------------------------------------------------------
type ConstraintsCapable = SceneNode & { constraints: { horizontal: string; vertical: string } };
type CornerCapable = SceneNode & { cornerRadius: number | typeof figma.mixed; fills: Paint[] | typeof figma.mixed };
type EffectsCapable = SceneNode & { effects: Effect[] | typeof figma.mixed };
type FillsCapable = SceneNode & { fills: Paint[] | typeof figma.mixed };
type StrokesCapable = SceneNode & { strokes: Paint[] };

interface ShadowSignature {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  hex: string;
  alpha: number;
  dx: number;
  dy: number;
  blur: number;
  spread: number;
}

interface AdhocTextEntry {
  node: TextNode;
  label: string;
}

interface ColorBindingCandidate {
  node: SceneNode;
  property: 'fills' | 'strokes';
  paint: SolidPaint;
  index: number;
}

export async function runDesignQAScan(scope: RunScope['scope'], ctx: HandlerContext): Promise<DesignQAResult> {
  const chunkSize = 250;
  const issues: Issue[] = [];

  const autoLayoutFrames: FrameNode[] = [];
  const radiusCandidates: Array<{ node: SceneNode; radius: number }> = [];
  const shadowCandidates: Array<{ node: SceneNode; sig: ShadowSignature }> = [];
  const adhocTextEntries: AdhocTextEntry[] = [];
  const colorBindingCandidates: ColorBindingCandidate[] = [];

  const roots = resolveScopeRoots(scope);
  const stack: SceneNode[] = [...roots];
  let visited = 0;

  while (stack.length > 0) {
    if (ctx.signal.cancelled) break;
    const node = stack.pop() as SceneNode;
    visited += 1;

    checkMissingConstraints(node, issues);

    if (node.type === 'FRAME') {
      if (node.layoutMode !== 'NONE') {
        autoLayoutFrames.push(node);
      } else if (node.children.length >= MIN_AUTO_LAYOUT_CANDIDATE_CHILDREN) {
        checkMissingAutoLayout(node, issues);
      }
    }

    collectRadius(node, radiusCandidates);
    collectShadow(node, shadowCandidates);
    if (node.type === 'TEXT') collectAdhocText(node, adhocTextEntries);
    collectColorBindingCandidates(node, colorBindingCandidates);

    if ('children' in node) {
      const kids = (node as ChildrenMixin & SceneNode).children;
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as SceneNode);
    }

    if (visited % chunkSize === 0) {
      ctx.reportProgress({ done: visited, total: visited + stack.length, label: 'Scanning layers…' });
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
  }
  ctx.reportProgress({ done: visited, total: visited, label: 'Analyzing patterns…' });

  analyzeSpacing(autoLayoutFrames, issues);
  analyzeRadius(radiusCandidates, issues);
  analyzeShadow(shadowCandidates, issues);
  analyzeTypography(adhocTextEntries, issues);
  analyzeDuplicateTextStyles(issues);
  await analyzeVariableBindings(colorBindingCandidates, issues, ctx);

  const summary: Record<string, number> = {};
  for (const issue of issues) summary[issue.ruleId] = (summary[issue.ruleId] ?? 0) + 1;

  return { scope, scannedAt: Date.now(), issues, summary };
}

// ---------------------------------------------------------------------------
// missing-constraints
// ---------------------------------------------------------------------------
/** Heuristic only: a node's parent being a non-auto-layout FRAME plus the
 * node still sitting on Figma's default `{ horizontal: 'MIN', vertical:
 * 'MIN' }` constraints does NOT prove a designer forgot to set constraints
 * — MIN/MIN is a perfectly valid, intentional top-left pin. This just
 * flags the common "never touched it" case for a human to confirm. */
function checkMissingConstraints(node: SceneNode, issues: Issue[]) {
  const parent = node.parent;
  if (!parent || parent.type !== 'FRAME') return;
  if (parent.layoutMode !== 'NONE') return; // auto-layout frames manage position themselves
  if (!('constraints' in node)) return;
  const constraints = (node as ConstraintsCapable).constraints;
  if (constraints.horizontal === 'MIN' && constraints.vertical === 'MIN') {
    issues.push({
      id: generateId('issue'),
      ruleId: 'missing-constraints',
      severity: 'warning',
      title: 'Layer left on default constraints',
      description: `"${node.name}" still uses Figma's default MIN/MIN constraints inside a non-auto-layout frame ("${parent.name}"). Confirm this is intentional, not just unset.`,
      node: toNodeRef(node),
      autoFixable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// missing-auto-layout
// ---------------------------------------------------------------------------
type LaidOutNode = SceneNode & { x: number; y: number; width: number; height: number };

function isLaidOutNode(node: SceneNode): node is LaidOutNode {
  return 'x' in node && 'width' in node;
}

function computeGaps(sorted: LaidOutNode[], posKey: 'x' | 'y', sizeKey: 'width' | 'height'): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1] as LaidOutNode;
    const cur = sorted[i] as LaidOutNode;
    gaps.push(cur[posKey] - (prev[posKey] + prev[sizeKey]));
  }
  return gaps;
}

function isEvenlySpaced(gaps: number[]): boolean {
  if (gaps.length === 0) return false;
  if (gaps.some((g) => g < -0.5)) return false; // overlapping children aren't a spacing pattern
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return gaps.every((g) => Math.abs(g - avg) <= EVEN_SPACING_TOLERANCE_PX);
}

function isRoughlyAligned(sorted: LaidOutNode[], crossKey: 'x' | 'y'): boolean {
  const first = sorted[0] as LaidOutNode;
  return sorted.every((n) => Math.abs(n[crossKey] - first[crossKey]) <= EVEN_SPACING_TOLERANCE_PX * 2);
}

/** Heuristic pattern detector, NOT a guarantee the frame *should* use auto
 * layout — only that its children currently happen to form an evenly
 * spaced row or column, which is exactly the shape auto layout +
 * itemSpacing was built to express. False positives are expected for
 * intentionally freeform frames whose children merely line up by chance. */
function checkMissingAutoLayout(frame: FrameNode, issues: Issue[]) {
  const kids = frame.children.filter(isLaidOutNode);
  if (kids.length < MIN_AUTO_LAYOUT_CANDIDATE_CHILDREN) return;

  const byX = [...kids].sort((a, b) => a.x - b.x);
  const byY = [...kids].sort((a, b) => a.y - b.y);

  const rowEven = isEvenlySpaced(computeGaps(byX, 'x', 'width'));
  const colEven = isEvenlySpaced(computeGaps(byY, 'y', 'height'));
  const rowAligned = rowEven && isRoughlyAligned(byX, 'y');
  const colAligned = colEven && isRoughlyAligned(byY, 'x');

  if (!rowAligned && !colAligned) return;

  const direction = rowAligned ? 'row' : 'column';
  issues.push({
    id: generateId('issue'),
    ruleId: 'missing-auto-layout',
    severity: 'warning',
    title: 'Frame looks auto-layout-able',
    description: `"${frame.name}" has ${kids.length} children arranged in an evenly spaced ${direction} but layoutMode is "NONE". Consider converting it to auto layout for resilience to content changes.`,
    node: toNodeRef(frame),
    meta: { direction, childCount: kids.length },
    autoFixable: false,
  });
}

// ---------------------------------------------------------------------------
// inconsistent-spacing
// ---------------------------------------------------------------------------
function statisticalMode(values: number[]): number | null {
  const freq = new Map<number, number>();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [v, c] of freq) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/** Collects itemSpacing across every auto-layout frame in scope, finds the
 * statistical mode (most common value), and flags frames whose spacing
 * deviates from that mode beyond SPACING_TOLERANCE_PX. Frames with
 * spacing:'AUTO' (space-between) report itemSpacing as a number too in the
 * Plugin API, so they're included like any fixed-gap frame — a false
 * positive is possible if a design intentionally mixes fixed and
 * space-between frames of different sizes. */
function analyzeSpacing(frames: FrameNode[], issues: Issue[]) {
  const values = frames.map((f) => Math.round(f.itemSpacing));
  if (values.length < MIN_SAMPLE_SIZE_FOR_CLUSTERING) return;
  const mode = statisticalMode(values);
  if (mode === null) return;

  for (const frame of frames) {
    const spacing = frame.itemSpacing;
    if (Math.abs(spacing - mode) > SPACING_TOLERANCE_PX) {
      issues.push({
        id: generateId('issue'),
        ruleId: 'inconsistent-spacing',
        severity: 'warning',
        title: 'Inconsistent auto-layout spacing',
        description: `"${frame.name}" uses itemSpacing ${spacing}px, but ${mode}px is the most common spacing across auto-layout frames in this scope.`,
        node: toNodeRef(frame),
        meta: { spacing, modeSpacing: mode },
        autoFixable: false,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// inconsistent-radius
// ---------------------------------------------------------------------------
interface Cluster {
  center: number;
  members: number[];
}

function clusterValues(values: number[], tolerance: number): Cluster[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: Cluster[] = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && v - last.center <= tolerance) {
      last.members.push(v);
      last.center = last.members.reduce((a, b) => a + b, 0) / last.members.length;
    } else {
      clusters.push({ center: v, members: [v] });
    }
  }
  return clusters;
}

function collectRadius(node: SceneNode, out: Array<{ node: SceneNode; radius: number }>) {
  if (!('cornerRadius' in node) || !('fills' in node)) return;
  const capable = node as CornerCapable;
  if (capable.fills === figma.mixed || !Array.isArray(capable.fills) || capable.fills.length === 0) return;
  if (!capable.fills.some((p) => p.visible !== false)) return;
  if (capable.cornerRadius === figma.mixed) return; // per-corner radii differ on this node itself — skip rather than guess
  if (typeof capable.cornerRadius !== 'number' || capable.cornerRadius <= 0) return;
  out.push({ node, radius: capable.cornerRadius });
}

/** Clusters observed corner-radius values within RADIUS_TOLERANCE_PX and
 * flags any node whose radius doesn't fall near a cluster used by at least
 * one other node — i.e. a genuine one-off value, not just "the less common
 * of two roughly-equally-used radii". */
function analyzeRadius(candidates: Array<{ node: SceneNode; radius: number }>, issues: Issue[]) {
  if (candidates.length < MIN_SAMPLE_SIZE_FOR_CLUSTERING) return;
  const clusters = clusterValues(
    candidates.map((c) => c.radius),
    RADIUS_TOLERANCE_PX
  );
  const commonClusters = clusters.filter((c) => c.members.length >= 2);
  if (commonClusters.length === 0) return;

  const commonValues = commonClusters.map((c) => Math.round(c.center));
  for (const { node, radius } of candidates) {
    const matchesCommon = commonClusters.some((c) => Math.abs(c.center - radius) <= RADIUS_TOLERANCE_PX);
    if (matchesCommon) continue;
    issues.push({
      id: generateId('issue'),
      ruleId: 'inconsistent-radius',
      severity: 'info',
      title: 'Corner radius outlier',
      description: `"${node.name}" uses a ${radius}px corner radius that doesn't match the common radii used elsewhere in scope (${commonValues.join('px, ')}px).`,
      node: toNodeRef(node),
      meta: { radius, commonValues },
      autoFixable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// inconsistent-shadow
// ---------------------------------------------------------------------------
function collectShadow(node: SceneNode, out: Array<{ node: SceneNode; sig: ShadowSignature }>) {
  if (!('effects' in node)) return;
  const effects = (node as EffectsCapable).effects;
  if (effects === figma.mixed || !Array.isArray(effects)) return;
  for (const effect of effects) {
    if (!effect.visible) continue;
    if (effect.type !== 'DROP_SHADOW' && effect.type !== 'INNER_SHADOW') continue;
    const rgb = figmaColorToRgb255(effect.color);
    out.push({
      node,
      sig: {
        type: effect.type,
        hex: rgbToHex(rgb),
        alpha: Math.round(effect.color.a * 100) / 100,
        dx: effect.offset.x,
        dy: effect.offset.y,
        blur: effect.radius,
        spread: effect.spread ?? 0,
      },
    });
  }
}

function shadowClusterKey(sig: ShadowSignature): string {
  const bucket = (n: number, step: number) => Math.round(n / step) * step;
  return [
    sig.type,
    sig.hex,
    sig.alpha,
    bucket(sig.dx, SHADOW_OFFSET_TOLERANCE_PX),
    bucket(sig.dy, SHADOW_OFFSET_TOLERANCE_PX),
    bucket(sig.blur, SHADOW_BLUR_TOLERANCE_PX),
    bucket(sig.spread, SHADOW_SPREAD_TOLERANCE_PX),
  ].join('|');
}

/** Same "outlier vs. cluster used more than once" logic as radius, but
 * over a compound (type, color, offset, blur, spread) signature bucketed
 * to the SHADOW_*_TOLERANCE_PX constants instead of a single numeric
 * cluster. */
function analyzeShadow(candidates: Array<{ node: SceneNode; sig: ShadowSignature }>, issues: Issue[]) {
  if (candidates.length < MIN_SAMPLE_SIZE_FOR_CLUSTERING) return;
  const freq = new Map<string, number>();
  for (const c of candidates) {
    const key = shadowClusterKey(c.sig);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const commonKeys = new Set([...freq.entries()].filter(([, n]) => n >= 2).map(([k]) => k));
  if (commonKeys.size === 0) return;

  for (const { node, sig } of candidates) {
    if (commonKeys.has(shadowClusterKey(sig))) continue;
    issues.push({
      id: generateId('issue'),
      ruleId: 'inconsistent-shadow',
      severity: 'info',
      title: 'Shadow style outlier',
      description: `"${node.name}" has a ${sig.type === 'DROP_SHADOW' ? 'drop' : 'inner'} shadow (${sig.hex} @ ${Math.round(sig.alpha * 100)}%, offset ${sig.dx}/${sig.dy}, blur ${sig.blur}${sig.spread ? `, spread ${sig.spread}` : ''}) that doesn't match a shadow style used elsewhere in scope.`,
      node: toNodeRef(node),
      meta: { signature: sig },
      autoFixable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// inconsistent-typography
// ---------------------------------------------------------------------------
function collectAdhocText(node: TextNode, out: AdhocTextEntry[]) {
  if (node.textStyleId === figma.mixed) return; // multiple styles within one node — no single signature to compare
  if (node.textStyleId !== '') return; // already bound to a shared text style
  const fontName = node.fontName;
  const fontSize = node.fontSize;
  const lineHeight = node.lineHeight;
  if (fontName === figma.mixed || fontSize === figma.mixed || lineHeight === figma.mixed) return;

  const lhLabel = lineHeight.unit === 'AUTO' ? 'auto' : `${Math.round(lineHeight.value)}${lineHeight.unit === 'PERCENT' ? '%' : 'px'}`;
  const label = `${fontName.family} ${fontName.style} / ${fontSize}px / ${lhLabel} line-height`;
  out.push({ node, label });
}

/** TEXT nodes not bound to a shared text style ("ad hoc" styling). Reports
 * one aggregate issue summarising how many distinct combos exist, plus a
 * capped sample of per-node issues (TYPOGRAPHY_SAMPLE_CAP) so a file with
 * thousands of unstyled text nodes doesn't produce thousands of rows. */
function analyzeTypography(entries: AdhocTextEntry[], issues: Issue[]) {
  if (entries.length === 0) return;

  const bySig = new Map<string, AdhocTextEntry[]>();
  for (const e of entries) {
    const list = bySig.get(e.label) ?? [];
    list.push(e);
    bySig.set(e.label, list);
  }

  if (bySig.size > 1) {
    issues.push({
      id: generateId('issue'),
      ruleId: 'inconsistent-typography',
      severity: 'warning',
      title: `${bySig.size} distinct ad-hoc text styles in use`,
      description: `${entries.length} text layer(s) in scope use a font/size/line-height combination that isn't bound to a shared text style, across ${bySig.size} distinct combinations. Consider consolidating into text styles.`,
      meta: { distinctCombos: bySig.size, totalNodes: entries.length, combos: [...bySig.keys()].slice(0, 20) },
      autoFixable: false,
    });
  }

  for (const entry of entries.slice(0, TYPOGRAPHY_SAMPLE_CAP)) {
    issues.push({
      id: generateId('issue'),
      ruleId: 'inconsistent-typography',
      severity: 'info',
      title: 'Text not bound to a text style',
      description: `"${entry.node.name}" uses ad-hoc styling (${entry.label}) instead of a shared text style.`,
      node: toNodeRef(entry.node),
      autoFixable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// duplicate-text-style
// ---------------------------------------------------------------------------
/** Flags local TEXT styles that share an identical (family, style, size,
 * line-height) signature but exist as separate style ids — usually two
 * designers independently creating e.g. "Body". Capped at
 * DUPLICATE_SAMPLE_CAP group issues. */
function analyzeDuplicateTextStyles(issues: Issue[]) {
  let styles: TextStyle[];
  try {
    styles = figma.getLocalTextStyles();
  } catch {
    return;
  }

  const bySig = new Map<string, TextStyle[]>();
  for (const style of styles) {
    if (style.fontName === figma.mixed || style.fontSize === figma.mixed || style.lineHeight === figma.mixed) continue;
    const lh = style.lineHeight;
    const lhLabel = lh.unit === 'AUTO' ? 'auto' : `${Math.round(lh.value)}${lh.unit === 'PERCENT' ? '%' : 'px'}`;
    const sig = `${style.fontName.family}|${style.fontName.style}|${style.fontSize}|${lhLabel}`;
    const list = bySig.get(sig) ?? [];
    list.push(style);
    bySig.set(sig, list);
  }

  let emitted = 0;
  for (const [sig, group] of bySig) {
    if (group.length < 2) continue;
    if (emitted >= DUPLICATE_SAMPLE_CAP) break;
    emitted += 1;
    issues.push({
      id: generateId('issue'),
      ruleId: 'duplicate-text-style',
      severity: 'warning',
      title: 'Duplicate text styles',
      description: `${group.length} local text styles (${group.map((s) => `"${s.name}"`).join(', ')}) share the same font, size and line-height (${sig.replace(/\|/g, ' / ')}). Consider consolidating into one.`,
      meta: { styleIds: group.map((s) => s.id), signature: sig },
      autoFixable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// missing-variable-binding
// ---------------------------------------------------------------------------
function collectColorBindingCandidates(node: SceneNode, out: ColorBindingCandidate[]) {
  if ('fills' in node) {
    const fills = (node as FillsCapable).fills;
    if (Array.isArray(fills)) {
      fills.forEach((paint, index) => {
        if (paint.type === 'SOLID' && paint.visible !== false) out.push({ node, property: 'fills', paint, index });
      });
    }
  }
  if ('strokes' in node) {
    const strokes = (node as StrokesCapable).strokes;
    if (Array.isArray(strokes)) {
      strokes.forEach((paint, index) => {
        if (paint.type === 'SOLID' && paint.visible !== false) out.push({ node, property: 'strokes', paint, index });
      });
    }
  }
}

/** Per-channel (0-255) comparison within COLOR_CHANNEL_TOLERANCE — used
 * instead of exact hex equality so near-identical colours (e.g. rounding
 * differences from a colour picker vs. a variable authored elsewhere)
 * still count as "matches this variable". */
function colorsMatch(a: RGB, b: RGB, tolerance: number): boolean {
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance;
}

/** Wrapped entirely in try/catch: `figma.variables` is only available on
 * editors/plans with variable support. If the API is missing or any call
 * throws, this rule silently reports 0 findings instead of failing the
 * whole Design QA scan. */
async function analyzeVariableBindings(candidates: ColorBindingCandidate[], issues: Issue[], ctx: HandlerContext): Promise<void> {
  if (candidates.length === 0) return;
  try {
    if (!figma.variables || typeof figma.variables.getLocalVariablesAsync !== 'function') return;
    const allVariables = await figma.variables.getLocalVariablesAsync();
    const colorVariables = allVariables.filter((v) => v.resolvedType === 'COLOR');
    if (colorVariables.length === 0) return;

    // Resolve each COLOR variable's first mode to an RGB triple. A
    // variable can carry a different value per mode, but for "does this
    // hardcoded color duplicate a token" purposes the default (first)
    // mode's value is the useful comparison — cross-mode matching is out
    // of scope here.
    const resolvedVariables: Array<{ variable: Variable; rgb: RGB }> = [];
    for (const variable of colorVariables) {
      const first = Object.values(variable.valuesByMode)[0];
      if (!first || typeof first !== 'object' || !('r' in first)) continue; // alias or non-color value
      resolvedVariables.push({ variable, rgb: figmaColorToRgb255(first as RGBA) });
    }
    if (resolvedVariables.length === 0) return;

    await processInChunksAsync(
      candidates,
      async ({ node, property, paint, index }) => {
        const rgb = figmaColorToRgb255(paint.color);
        const match = resolvedVariables.find((v) => colorsMatch(v.rgb, rgb, COLOR_CHANNEL_TOLERANCE));
        if (!match) return;
        const bound = paint.boundVariables?.color;
        if (bound && bound.id === match.variable.id) return; // already correctly bound

        const hex = rgbToHex(rgb);
        issues.push({
          id: generateId('issue'),
          ruleId: 'missing-variable-binding',
          severity: 'info',
          title: 'Hardcoded color matches an existing variable',
          description: `"${node.name}" has a ${property === 'fills' ? 'fill' : 'stroke'} colour (${hex}) that matches the local variable "${match.variable.name}" but isn't bound to it.`,
          node: toNodeRef(node),
          meta: { property, index, hex, variableId: match.variable.id, variableName: match.variable.name },
          autoFixable: false,
        });
      },
      { chunkSize: 100, signal: ctx.signal }
    );
  } catch {
    // Variables API unavailable (or errored) on this editor/plan — 0 findings, not an error.
  }
}
