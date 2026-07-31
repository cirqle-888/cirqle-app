/** Document Analytics: a single chunked walk over the requested scope
 * ('page' or 'document') that tallies structural counts and derives a
 * couple of composite scores from them. Everything here is read-only. */
import type { HandlerContext } from '../../bridge';
import { resolveScopeRoots } from '../../utils/traversal';
import { yieldToEventLoop } from '../../utils/chunk';
import { MAX_LAYERS_WARNING_THRESHOLD } from '@shared/constants';
import type { RunScope } from '@shared/types';

export interface AnalyticsSnapshot {
  scope: RunScope['scope'];
  scannedAt: number;
  totalNodeCount: number;
  maxNestingDepth: number;
  pageCount: number;
  frameCount: number;
  /** COMPONENT nodes whose parent is NOT a COMPONENT_SET — i.e. standalone
   * component definitions. Variants (components that live inside a
   * COMPONENT_SET) are reported separately as `variantCount`; combining the
   * two gives every COMPONENT node in scope. */
  componentCount: number;
  /** Children of COMPONENT_SET nodes — i.e. individual variants of a
   * variant-enabled component. */
  variantCount: number;
  imageCount: {
    /** Distinct `imageHash`es referenced by any IMAGE paint in scope. */
    distinct: number;
    /** Every IMAGE paint usage across every fill array, including repeats
     * of the same hash on different nodes (or multiple times on one node). */
    totalUsages: number;
  };
  vectorCount: number;
  fontsUsed: {
    /** Distinct "Family Style" combinations seen on TEXT nodes. */
    distinct: number;
    families: string[];
    /** TEXT nodes skipped because `fontName` was `figma.mixed` (multiple
     * styles within one node) — flagged rather than guessed at. */
    mixedStyleTextNodeCount: number;
  };
  styleCounts: {
    paint: number;
    text: number;
    effect: number;
    grid: number;
  };
  /** `null` (not `0`) means the Variables API wasn't available on this
   * editor/plan/version — the UI must render "unavailable", not "0". */
  variableCount: number | null;
  /**
   * Heuristic ONLY. The Figma Plugin API exposes no real byte size for a
   * file or any node in it, so this is a weighted sum by node-type counts,
   * loosely calibrated against typical per-node-type overhead (raster
   * fills dominate, vectors > text > frames, plus a flat per-node
   * baseline). Useful for *relative* comparison between scans of the same
   * file over time — NOT a real KB estimate of the .fig file.
   */
  estimatedFileSizeKb: number;
  /**
   * 0-100 composite, computed as:
   *   nodeScore  = min(1, totalNodeCount / MAX_LAYERS_WARNING_THRESHOLD) * 50
   *   depthScore = min(1, maxNestingDepth / 30) * 30
   *   styleScore = min(1, distinctLocalStyleCount / 50) * 20
   *   complexityScore = round(nodeScore + depthScore + styleScore)
   * Higher = more complex. distinctLocalStyleCount is the sum of local
   * paint/text/effect/grid style counts (styles *defined*, not necessarily
   * all *used* — a cheap proxy for "how much of a design system exists").
   */
  complexityScore: number;
  /**
   * 0-100, higher = healthier performance outlook. Starts at 100 and
   * subtracts penalties:
   *   - up to 50 pts for node volume: (totalNodeCount / MAX_LAYERS_WARNING_THRESHOLD) * 50
   *   - up to 25 pts for nesting beyond 10 levels deep: 2 pts/level past 10
   *   - up to 25 pts for "loose" vectors: 0.5 pt per VECTOR node whose
   *     direct parent is a FRAME or PAGE (i.e. not grouped/boolean'd/inside
   *     a component) — many ungrouped vectors is a classic perf smell.
   */
  performanceScore: number;
}

type FillsCapable = SceneNode & { fills: Paint[] | typeof figma.mixed };

function isFillsCapable(node: SceneNode): node is FillsCapable {
  return 'fills' in node;
}

export async function runAnalyticsScan(scope: RunScope['scope'], ctx: HandlerContext): Promise<AnalyticsSnapshot> {
  const chunkSize = 250;

  let totalNodeCount = 0;
  let maxNestingDepth = 0;
  let frameCount = 0;
  let componentCount = 0;
  let variantCount = 0;
  let vectorCount = 0;
  let looseVectorCount = 0;
  let textNodeCount = 0;
  let mixedStyleTextNodeCount = 0;

  const distinctImageHashes = new Set<string>();
  let imageFillUsages = 0;
  const distinctFontLabels = new Set<string>();

  const roots = resolveScopeRoots(scope);
  const stack: Array<{ node: SceneNode; depth: number }> = roots.map((node) => ({ node, depth: 1 }));
  let visited = 0;

  while (stack.length > 0) {
    if (ctx.signal.cancelled) break;
    const { node, depth } = stack.pop() as { node: SceneNode; depth: number };
    visited += 1;
    totalNodeCount += 1;
    if (depth > maxNestingDepth) maxNestingDepth = depth;

    switch (node.type) {
      case 'FRAME':
        frameCount += 1;
        break;
      case 'COMPONENT':
        if (node.parent?.type === 'COMPONENT_SET') variantCount += 1;
        else componentCount += 1;
        break;
      case 'VECTOR':
        vectorCount += 1;
        if (node.parent?.type === 'FRAME' || node.parent?.type === 'PAGE') looseVectorCount += 1;
        break;
      case 'TEXT': {
        textNodeCount += 1;
        const fontName = node.fontName;
        if (fontName === figma.mixed) {
          mixedStyleTextNodeCount += 1;
        } else {
          distinctFontLabels.add(`${fontName.family} ${fontName.style}`);
        }
        break;
      }
      default:
        break;
    }

    if (isFillsCapable(node) && Array.isArray(node.fills)) {
      for (const paint of node.fills) {
        if (paint.type === 'IMAGE' && paint.imageHash) {
          imageFillUsages += 1;
          distinctImageHashes.add(paint.imageHash);
        }
      }
    }

    if ('children' in node) {
      const kids = (node as ChildrenMixin & SceneNode).children;
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        stack.push({ node: kids[i] as SceneNode, depth: depth + 1 });
      }
    }

    if (visited % chunkSize === 0) {
      ctx.reportProgress({ done: visited, total: visited + stack.length, label: 'Scanning layers…' });
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
  }
  ctx.reportProgress({ done: visited, total: visited, label: 'Computing scores…' });

  const paintStyleCount = figma.getLocalPaintStyles().length;
  const textStyleCount = figma.getLocalTextStyles().length;
  const effectStyleCount = figma.getLocalEffectStyles().length;
  const gridStyleCount = figma.getLocalGridStyles().length;

  let variableCount: number | null = null;
  try {
    if (figma.variables && typeof figma.variables.getLocalVariablesAsync === 'function') {
      const variables = await figma.variables.getLocalVariablesAsync();
      variableCount = variables.length;
    }
  } catch {
    variableCount = null; // Variables API not available on this editor/plan.
  }

  const distinctStyleCount = paintStyleCount + textStyleCount + effectStyleCount + gridStyleCount;

  const estimatedFileSizeKb = Math.round(
    frameCount * 0.4 +
      componentCount * 0.6 +
      variantCount * 0.5 +
      textNodeCount * 0.3 +
      vectorCount * 1.2 +
      distinctImageHashes.size * 45 +
      totalNodeCount * 0.05
  );

  const nodeScore = Math.min(1, totalNodeCount / MAX_LAYERS_WARNING_THRESHOLD) * 50;
  const depthScore = Math.min(1, maxNestingDepth / 30) * 30;
  const styleScore = Math.min(1, distinctStyleCount / 50) * 20;
  const complexityScore = Math.round(nodeScore + depthScore + styleScore);

  const nodePenalty = Math.min(50, (totalNodeCount / MAX_LAYERS_WARNING_THRESHOLD) * 50);
  const depthPenalty = Math.min(25, Math.max(0, maxNestingDepth - 10) * 2);
  const vectorPenalty = Math.min(25, looseVectorCount * 0.5);
  const performanceScore = Math.round(Math.max(0, 100 - nodePenalty - depthPenalty - vectorPenalty));

  return {
    scope,
    scannedAt: Date.now(),
    totalNodeCount,
    maxNestingDepth,
    pageCount: figma.root.children.length,
    frameCount,
    componentCount,
    variantCount,
    imageCount: { distinct: distinctImageHashes.size, totalUsages: imageFillUsages },
    vectorCount,
    fontsUsed: {
      distinct: distinctFontLabels.size,
      families: [...distinctFontLabels].sort(),
      mixedStyleTextNodeCount,
    },
    styleCounts: { paint: paintStyleCount, text: textStyleCount, effect: effectStyleCount, grid: gridStyleCount },
    variableCount,
    estimatedFileSizeKb,
    complexityScore: Math.min(100, complexityScore),
    performanceScore,
  };
}
