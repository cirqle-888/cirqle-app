/**
 * Cleaner detectors. Unlike renameEngine.ts these are NOT pure — they need
 * live `figma` access (walking the tree, reading local styles) — but each
 * detector is a small, independently-testable-in-spirit function tagged
 * with a stable `ruleId` string so the UI can group/count/ignore by rule.
 *
 * Quick mode = {hidden-layer, invisible-object, empty-group, empty-frame,
 * zero-size, off-canvas, empty-section}: all cheap, single-pass, no hashing,
 * no extra API calls beyond the one tree walk every scan already does.
 * Deep mode adds everything else (duplicate detection, style analysis,
 * detached-instance resolution), which cost extra passes and/or async
 * Figma API calls.
 */
import type { HandlerContext } from '../../bridge';
import type { Issue, RunScope, Severity } from '@shared/types';
import { MAX_LAYERS_WARNING_THRESHOLD } from '@shared/constants';
import { generateId } from '@shared/id';
import { collectNodes, toNodeRef } from '../../utils/traversal';
import { processInChunks, processInChunksAsync, type ChunkOptions } from '../../utils/chunk';
import { logger } from '../../utils/logger';

/** Heuristic threshold for the off-canvas check — a node whose position is
 * further than this from its nearest ancestor frame's origin is flagged as
 * "probably stray". Configurable here; not exposed in the UI today. */
export const OFF_CANVAS_THRESHOLD_PX = 4000;

export type CleanerMode = 'quick' | 'deep';

export interface CleanerScanResult {
  issues: Issue[];
  counts: Record<string, number>;
  /** Rough, non-authoritative estimate — see estimateSizeImpactKb() below.
   * The Plugin API does not expose real byte sizes for most node types. */
  estimatedSizeImpactKb: number;
  /** 0 (healthy) - 100 (at/above MAX_LAYERS_WARNING_THRESHOLD and cluttered).
   * A weighted proxy, not a measurement — Figma's Plugin API has no memory
   * introspection API. */
  estimatedMemoryScore: number;
}

// ---------------------------------------------------------------------------
// Structural type guards (kept structural rather than importing exact mixin
// interface names from @figma/plugin-typings, since those names have moved
// around across API versions — this is resilient to that).
// ---------------------------------------------------------------------------
function hasFills(node: SceneNode): node is SceneNode & { fills: readonly Paint[] | typeof figma.mixed } {
  return 'fills' in node;
}
function hasOpacity(node: SceneNode): node is SceneNode & { opacity: number } {
  return 'opacity' in node;
}
function hasPosition(node: SceneNode): node is SceneNode & { x: number; y: number } {
  return 'x' in node && 'y' in node;
}
function hasSize(node: SceneNode): node is SceneNode & { width: number; height: number } {
  return 'width' in node && 'height' in node;
}
function hasStyleIds(
  node: SceneNode
): node is SceneNode & {
  fillStyleId?: string | typeof figma.mixed;
  strokeStyleId?: string | typeof figma.mixed;
  textStyleId?: string | typeof figma.mixed;
} {
  return 'fillStyleId' in node || 'strokeStyleId' in node || 'textStyleId' in node;
}

function makeIssue(
  ruleId: string,
  severity: Severity,
  title: string,
  description: string,
  node: SceneNode,
  autoFixable: boolean,
  meta?: Record<string, unknown>
): Issue {
  return {
    id: generateId('issue'),
    ruleId,
    severity,
    title,
    description,
    node: toNodeRef(node),
    autoFixable,
    meta,
  };
}

function isInvisible(node: SceneNode): boolean {
  if (hasOpacity(node) && node.opacity === 0) return true;
  if (!hasFills(node)) return false;
  const fills = node.fills;
  if (fills === figma.mixed || !Array.isArray(fills) || fills.length === 0) return false;
  return fills.every((paint) => paint.visible === false || paint.opacity === 0);
}

function nearestAncestorFrameOrigin(node: SceneNode): { x: number; y: number } | null {
  let current: BaseNode | null = node.parent;
  while (current) {
    if (
      current.type === 'FRAME' ||
      current.type === 'COMPONENT' ||
      current.type === 'COMPONENT_SET' ||
      current.type === 'SECTION'
    ) {
      return { x: current.x, y: current.y };
    }
    current = current.parent;
  }
  return null;
}

/** Heuristic only: compares a node's parent-relative x/y against its nearest
 * ancestor frame/section's own x/y (which is itself relative to *its*
 * parent). This is not a true "distance from canvas origin" calculation —
 * it's a cheap proxy for "is this suspiciously far from where it's
 * contained", which is good enough to surface stray/forgotten layers
 * without walking the full absoluteTransform chain for every node. */
function isOffCanvas(node: SceneNode): boolean {
  if (!hasPosition(node)) return false;
  const origin = nearestAncestorFrameOrigin(node);
  const dx = origin ? node.x - origin.x : node.x;
  const dy = origin ? node.y - origin.y : node.y;
  return Math.abs(dx) > OFF_CANVAS_THRESHOLD_PX || Math.abs(dy) > OFF_CANVAS_THRESHOLD_PX;
}

// ---------------------------------------------------------------------------
// Quick-mode detectors — single cheap pass over every node.
// ---------------------------------------------------------------------------
function detectQuickIssuesForNode(node: SceneNode): Issue[] {
  const issues: Issue[] = [];

  if (node.visible === false) {
    issues.push(makeIssue('hidden-layer', 'info', 'Hidden layer', `"${node.name}" is hidden (visible = false).`, node, true));
  }

  if (isInvisible(node)) {
    issues.push(
      makeIssue(
        'invisible-object',
        'info',
        'Invisible object',
        `"${node.name}" is fully transparent — opacity is 0, or every fill is invisible / zero-opacity.`,
        node,
        true
      )
    );
  }

  if (node.type === 'GROUP' && node.children.length === 0) {
    issues.push(makeIssue('empty-group', 'warning', 'Empty group', `"${node.name}" is a group with no children.`, node, true));
  }
  if (node.type === 'FRAME' && node.children.length === 0) {
    issues.push(makeIssue('empty-frame', 'warning', 'Empty frame', `"${node.name}" is a frame with no children.`, node, true));
  }
  if (node.type === 'SECTION' && node.children.length === 0) {
    issues.push(makeIssue('empty-section', 'warning', 'Empty section', `"${node.name}" is a section with no children.`, node, true));
  }

  if (hasSize(node) && (node.width === 0 || node.height === 0)) {
    issues.push(makeIssue('zero-size', 'warning', 'Zero-size layer', `"${node.name}" has a width or height of 0.`, node, false));
  }

  if (isOffCanvas(node)) {
    issues.push(
      makeIssue(
        'off-canvas',
        'info',
        'Off-canvas layer',
        `"${node.name}" sits more than ${OFF_CANVAS_THRESHOLD_PX}px from its containing frame's origin — likely stray or forgotten. Heuristic; verify before deleting.`,
        node,
        false
      )
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Deep-mode detectors.
// ---------------------------------------------------------------------------

/** Groups nodes with an IMAGE fill by imageHash. Every usage beyond the
 * first in a group is reported as a duplicate. */
async function detectDuplicateImages(nodes: SceneNode[], options: ChunkOptions): Promise<Issue[]> {
  const usage = new Map<string, SceneNode[]>();

  await processInChunks(
    nodes,
    (node) => {
      if (!hasFills(node)) return;
      const fills = node.fills;
      if (fills === figma.mixed || !Array.isArray(fills)) return;
      for (const paint of fills) {
        if (paint.type === 'IMAGE' && paint.visible !== false && typeof paint.imageHash === 'string') {
          const list = usage.get(paint.imageHash) ?? [];
          list.push(node);
          usage.set(paint.imageHash, list);
        }
      }
    },
    options
  );

  const issues: Issue[] = [];
  for (const [hash, list] of usage) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i += 1) {
      const node = list[i];
      if (!node) continue;
      issues.push(
        makeIssue(
          'duplicate-image',
          'info',
          'Duplicate image',
          `"${node.name}" reuses an image already used ${list.length} times in this scan (hash ${hash.slice(0, 10)}…).`,
          node,
          false,
          { imageHash: hash, usageCount: list.length }
        )
      );
    }
  }
  return issues;
}

/**
 * Heuristic fingerprint: name + rounded width/height + child count. This is
 * NOT byte-identical / structural-diff detection — two components that
 * happen to share a name, rounded size and immediate child count will be
 * flagged as "possible duplicates" even if their internals differ. Treat it
 * as a prompt to review, not a guarantee.
 */
function detectDuplicateComponents(nodes: SceneNode[]): Issue[] {
  const groups = new Map<string, ComponentNode[]>();
  for (const node of nodes) {
    if (node.type !== 'COMPONENT') continue;
    const fingerprint = `${node.name}|${Math.round(node.width)}x${Math.round(node.height)}|${node.children.length}`;
    const list = groups.get(fingerprint) ?? [];
    list.push(node);
    groups.set(fingerprint, list);
  }

  const issues: Issue[] = [];
  for (const [fingerprint, list] of groups) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i += 1) {
      const node = list[i];
      if (!node) continue;
      issues.push(
        makeIssue(
          'duplicate-component',
          'info',
          'Possible duplicate component',
          `"${node.name}" has the same name, size and child count as another local component — heuristic match, review before merging.`,
          node,
          false,
          { fingerprint, groupSize: list.length }
        )
      );
    }
  }
  return issues;
}

/** Local paint/text styles grouped by a signature of their key visual
 * properties; groups of 2+ are flagged. Style-level issues have no `node`
 * (styles aren't scene nodes), only `meta.styleId`. */
async function detectDuplicateStyles(): Promise<Issue[]> {
  const issues: Issue[] = [];

  try {
    const paintStyles = await figma.getLocalPaintStylesAsync();
    const groups = new Map<string, PaintStyle[]>();
    for (const style of paintStyles) {
      const sig = JSON.stringify(
        style.paints.map((p) => ({
          type: p.type,
          opacity: p.opacity,
          color: 'color' in p ? p.color : undefined,
        }))
      );
      const list = groups.get(sig) ?? [];
      list.push(style);
      groups.set(sig, list);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      for (let i = 1; i < list.length; i += 1) {
        const style = list[i];
        if (!style) continue;
        issues.push({
          id: generateId('issue'),
          ruleId: 'duplicate-style',
          severity: 'info',
          title: 'Duplicate paint style',
          description: `Paint style "${style.name}" has the same fills as another local paint style.`,
          autoFixable: false,
          meta: { styleId: style.id, styleType: 'paint', groupSize: list.length },
        });
      }
    }
  } catch (err) {
    logger.warn('cleaner: failed to scan paint styles for duplicates', err);
  }

  try {
    const textStyles = await figma.getLocalTextStylesAsync();
    const groups = new Map<string, TextStyle[]>();
    for (const style of textStyles) {
      const sig = JSON.stringify({
        family: style.fontName.family,
        weight: style.fontName.style,
        size: style.fontSize,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      });
      const list = groups.get(sig) ?? [];
      list.push(style);
      groups.set(sig, list);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      for (let i = 1; i < list.length; i += 1) {
        const style = list[i];
        if (!style) continue;
        issues.push({
          id: generateId('issue'),
          ruleId: 'duplicate-style',
          severity: 'info',
          title: 'Duplicate text style',
          description: `Text style "${style.name}" has the same font, size, line-height and letter-spacing as another local text style.`,
          autoFixable: false,
          meta: { styleId: style.id, styleType: 'text', groupSize: list.length },
        });
      }
    }
  } catch (err) {
    logger.warn('cleaner: failed to scan text styles for duplicates', err);
  }

  return issues;
}

async function resolveMainComponent(node: InstanceNode): Promise<BaseNode | null> {
  const withAsync = node as unknown as { getMainComponentAsync?: () => Promise<ComponentNode | null> };
  if (typeof withAsync.getMainComponentAsync === 'function') {
    return withAsync.getMainComponentAsync();
  }
  return node.mainComponent;
}

/** INSTANCE nodes whose main component can't be resolved — deleted upstream
 * component, or a genuinely detached instance. Prefers the async accessor
 * (required under documentAccess: "dynamic-page"), falls back to the sync
 * `.mainComponent` getter, and never lets a resolution failure abort the
 * scan (treated the same as "detached"). */
async function detectDetachedInstances(nodes: SceneNode[], options: ChunkOptions): Promise<Issue[]> {
  const instances = nodes.filter((n): n is InstanceNode => n.type === 'INSTANCE');

  return processInChunksAsync(
    instances,
    async (node) => {
      try {
        const main = await resolveMainComponent(node);
        if (!main) {
          return makeIssue(
            'detached-instance',
            'warning',
            'Detached instance',
            `"${node.name}" is an instance whose main component could not be resolved (likely deleted upstream).`,
            node,
            false
          );
        }
        return undefined;
      } catch (err) {
        logger.warn(`cleaner: could not resolve main component for instance ${node.id}`, err);
        return makeIssue(
          'detached-instance',
          'warning',
          'Detached instance',
          `"${node.name}" is an instance whose main component could not be resolved.`,
          node,
          false
        );
      }
    },
    { ...options, chunkSize: 25 }
  );
}

/** Deep-mode only, and only meaningful with scope=Document — a style being
 * "unused within just the current Selection" isn't a real signal, since the
 * style may well be used elsewhere in the document. The UI surfaces this
 * caveat next to the toggle. */
async function detectUnusedStyles(nodes: SceneNode[], options: ChunkOptions): Promise<Issue[]> {
  const usedIds = new Set<string>();

  await processInChunks(
    nodes,
    (node) => {
      if (!hasStyleIds(node)) return;
      if (typeof node.fillStyleId === 'string' && node.fillStyleId) usedIds.add(node.fillStyleId);
      if (typeof node.strokeStyleId === 'string' && node.strokeStyleId) usedIds.add(node.strokeStyleId);
      if (typeof node.textStyleId === 'string' && node.textStyleId) usedIds.add(node.textStyleId);
    },
    options
  );

  const issues: Issue[] = [];

  try {
    const paintStyles = await figma.getLocalPaintStylesAsync();
    for (const style of paintStyles) {
      if (usedIds.has(style.id)) continue;
      issues.push({
        id: generateId('issue'),
        ruleId: 'unused-paint-style',
        severity: 'info',
        title: 'Unused paint style',
        description: `Local paint style "${style.name}" isn't applied to any layer in the scanned scope.`,
        autoFixable: false,
        meta: { styleId: style.id },
      });
    }
  } catch (err) {
    logger.warn('cleaner: failed to scan for unused paint styles', err);
  }

  try {
    const textStyles = await figma.getLocalTextStylesAsync();
    for (const style of textStyles) {
      if (usedIds.has(style.id)) continue;
      issues.push({
        id: generateId('issue'),
        ruleId: 'unused-text-style',
        severity: 'info',
        title: 'Unused text style',
        description: `Local text style "${style.name}" isn't applied to any layer in the scanned scope.`,
        autoFixable: false,
        meta: { styleId: style.id },
      });
    }
  } catch (err) {
    logger.warn('cleaner: failed to scan for unused text styles', err);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Size / memory estimates. Both are deliberately simple, documented
// heuristics — the Plugin API exposes no real byte-size or memory-usage
// numbers for nodes, styles or images.
// ---------------------------------------------------------------------------
const SIZE_ESTIMATE_KB: Record<string, number> = {
  'hidden-layer': 0.2,
  'invisible-object': 0.2,
  'empty-group': 0.1,
  'empty-frame': 0.1,
  'empty-section': 0.1,
  'zero-size': 0.1,
  'off-canvas': 0.1,
  'duplicate-image': 45, // rough "typical embedded raster image" assumption
  'duplicate-component': 2,
  'duplicate-style': 0.05,
  'detached-instance': 0.3,
  'unused-paint-style': 0.05,
  'unused-text-style': 0.05,
};

function estimateSizeImpactKb(issues: Issue[]): number {
  let total = 0;
  for (const issue of issues) {
    total += SIZE_ESTIMATE_KB[issue.ruleId] ?? 0.1;
  }
  return Math.round(total * 10) / 10;
}

function estimateMemoryScore(totalNodesScanned: number, issueCount: number): number {
  const nodeRatio = Math.min(1, totalNodesScanned / MAX_LAYERS_WARNING_THRESHOLD);
  const issueRatio = totalNodesScanned > 0 ? Math.min(1, issueCount / Math.max(1, totalNodesScanned)) : 0;
  const score = nodeRatio * 70 + issueRatio * 30;
  return Math.round(Math.min(100, Math.max(0, score)));
}

export async function scanCleaner(
  scope: RunScope['scope'],
  mode: CleanerMode,
  ctx: HandlerContext,
  isIgnored: (ruleId: string, nodeId: string) => boolean
): Promise<CleanerScanResult> {
  const baseOptions: ChunkOptions = {
    chunkSize: 250,
    signal: ctx.signal,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Walking the layer tree…' }),
  };

  const nodes = await collectNodes(scope, () => true, baseOptions);

  const quickResults = await processInChunks(nodes, (node) => detectQuickIssuesForNode(node), {
    ...baseOptions,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Checking layers…' }),
  });
  let issues: Issue[] = quickResults.flat();

  if (mode === 'deep') {
    const silentOptions: ChunkOptions = { chunkSize: 250, signal: ctx.signal };

    ctx.reportProgress({ done: 0, total: 1, indeterminate: true, label: 'Checking for duplicate images…' });
    issues = issues.concat(await detectDuplicateImages(nodes, silentOptions));

    ctx.reportProgress({ done: 0, total: 1, indeterminate: true, label: 'Checking for duplicate components…' });
    issues = issues.concat(detectDuplicateComponents(nodes));

    ctx.reportProgress({ done: 0, total: 1, indeterminate: true, label: 'Checking local styles…' });
    issues = issues.concat(await detectDuplicateStyles());

    if (!ctx.signal.cancelled) {
      ctx.reportProgress({ done: 0, total: 1, indeterminate: true, label: 'Checking instances…' });
      issues = issues.concat(await detectDetachedInstances(nodes, silentOptions));
    }

    if (!ctx.signal.cancelled) {
      ctx.reportProgress({ done: 0, total: 1, indeterminate: true, label: 'Checking for unused styles…' });
      issues = issues.concat(await detectUnusedStyles(nodes, silentOptions));
    }
  }

  issues = issues.filter((issue) => !(issue.node && isIgnored(issue.ruleId, issue.node.id)));

  const counts: Record<string, number> = {};
  for (const issue of issues) {
    counts[issue.ruleId] = (counts[issue.ruleId] ?? 0) + 1;
  }

  return {
    issues,
    counts,
    estimatedSizeImpactKb: estimateSizeImpactKb(issues),
    estimatedMemoryScore: estimateMemoryScore(nodes.length, issues.length),
  };
}
