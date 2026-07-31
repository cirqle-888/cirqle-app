/**
 * Asset Manager scan: duplicate images (same hash, 2+ layers), large images
 * (over a byte-size threshold), and a best-effort "possibly unused"
 * heuristic. Chunked throughout; the byte-fetching pass in particular uses
 * processInChunksAsync keyed by DISTINCT HASH (not by node/usage), since
 * `getBytesAsync()` is the slow part and the same image is very commonly
 * reused across many layers (icons, logos, photo placeholders…).
 */
import type { HandlerContext } from '../../bridge';
import type { Issue, RunScope } from '@shared/types';
import { generateId } from '@shared/id';
import { processInChunks, processInChunksAsync } from '../../utils/chunk';
import { collectNodes, toNodeRef } from '../../utils/traversal';
import { getImagePaints, getImageMeta, type ImagePaintSource } from './imageHash';

export const LARGE_IMAGE_THRESHOLD_BYTES = 500 * 1024;

export interface AssetIssueMeta {
  hash: string;
  nodeIds: string[];
  occurrences: number;
  /** One representative paint reference per distinct node using this hash —
   * enough for the UI to drive a compress/replace round trip without
   * needing a second lookup. */
  refs: { nodeId: string; property: ImagePaintSource; paintIndex: number }[];
  bytesLength?: number;
}

export interface AssetScanResult {
  duplicates: Issue<AssetIssueMeta>[];
  large: Issue<AssetIssueMeta>[];
  possiblyUnused: Issue<AssetIssueMeta>[];
}

/** Off-canvas threshold in px. Approximate only — see isOffCanvasApprox. */
const OFF_CANVAS_THRESHOLD_PX = 8000;

function isNodeHiddenRecursive(node: SceneNode): boolean {
  let current: BaseNode | null = node;
  while (current && 'visible' in current) {
    if ((current as SceneNode).visible === false) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Approximate "is this node off-canvas" heuristic. Figma pages are
 * infinite and have no authoritative canvas boundary, so this is a rough
 * proxy only: a node whose absolute position is implausibly far from the
 * origin is *probably* an old/parked/archived layer rather than something
 * actively used in a shipped design. False positives are expected for
 * legitimately huge or far-flung canvases — treat this as a hint, not a
 * verdict. Deliberately self-contained here rather than imported from the
 * Cleaner module (which may define its own, possibly different, heuristic).
 */
function isOffCanvasApprox(node: SceneNode): boolean {
  const x = 'x' in node ? node.x : 0;
  const y = 'y' in node ? node.y : 0;
  return Math.abs(x) > OFF_CANVAS_THRESHOLD_PX || Math.abs(y) > OFF_CANVAS_THRESHOLD_PX;
}

interface HashUsage {
  hash: string;
  nodes: Map<string, SceneNode>;
  refs: Map<string, { nodeId: string; property: ImagePaintSource; paintIndex: number }>;
  occurrences: number;
}

export async function scanAssets(scope: RunScope['scope'], ctx: HandlerContext): Promise<AssetScanResult> {
  const nodes = await collectNodes(scope, (n) => getImagePaints(n).length > 0, {
    signal: ctx.signal,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Finding image fills…' }),
  });

  const byHash = new Map<string, HashUsage>();
  await processInChunks(
    nodes,
    (node) => {
      for (const ref of getImagePaints(node)) {
        let entry = byHash.get(ref.imageHash);
        if (!entry) {
          entry = { hash: ref.imageHash, nodes: new Map(), refs: new Map(), occurrences: 0 };
          byHash.set(ref.imageHash, entry);
        }
        entry.nodes.set(node.id, node);
        if (!entry.refs.has(node.id)) {
          entry.refs.set(node.id, { nodeId: node.id, property: ref.property, paintIndex: ref.paintIndex });
        }
        entry.occurrences += 1;
      }
      return undefined;
    },
    { signal: ctx.signal }
  );

  // Dedupe by hash FIRST, then fetch bytes once per distinct hash.
  const uniqueHashes = [...byHash.keys()];
  const metaByHash = new Map<string, number>();
  await processInChunksAsync(
    uniqueHashes,
    async (hash) => {
      const meta = await getImageMeta(hash);
      if (meta) metaByHash.set(hash, meta.bytesLength);
      return undefined;
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Reading image bytes (deduped by hash)…' }) }
  );

  const duplicates: Issue<AssetIssueMeta>[] = [];
  const large: Issue<AssetIssueMeta>[] = [];
  const possiblyUnused: Issue<AssetIssueMeta>[] = [];

  for (const usage of byHash.values()) {
    const bytesLength = metaByHash.get(usage.hash);
    const nodeList = [...usage.nodes.values()];
    const firstNode = nodeList[0];
    const meta: AssetIssueMeta = {
      hash: usage.hash,
      nodeIds: [...usage.nodes.keys()],
      occurrences: usage.occurrences,
      refs: [...usage.refs.values()],
      bytesLength,
    };

    if (usage.nodes.size >= 2) {
      duplicates.push({
        id: generateId('issue'),
        ruleId: 'assetManager/duplicate-image',
        severity: 'info',
        title: `Image reused across ${usage.nodes.size} layers`,
        description: `The same image (hash ${usage.hash.slice(0, 10)}…) is used by ${usage.nodes.size} distinct layer(s), ${usage.occurrences} paint usage(s) total.`,
        node: firstNode ? toNodeRef(firstNode) : undefined,
        meta,
        autoFixable: false,
      });
    }

    if (bytesLength !== undefined && bytesLength > LARGE_IMAGE_THRESHOLD_BYTES) {
      large.push({
        id: generateId('issue'),
        ruleId: 'assetManager/large-image',
        severity: 'warning',
        title: `Large image (${Math.round(bytesLength / 1024)} KB)`,
        description: `Image (hash ${usage.hash.slice(0, 10)}…) is ${Math.round(bytesLength / 1024)} KB, over the ${Math.round(
          LARGE_IMAGE_THRESHOLD_BYTES / 1024
        )} KB threshold. Used by ${usage.nodes.size} layer(s).`,
        node: firstNode ? toNodeRef(firstNode) : undefined,
        meta,
        autoFixable: false,
      });
    }

    const allHiddenOrOffCanvas = nodeList.length > 0 && nodeList.every((n) => isNodeHiddenRecursive(n) || isOffCanvasApprox(n));
    if (allHiddenOrOffCanvas) {
      possiblyUnused.push({
        id: generateId('issue'),
        ruleId: 'assetManager/possibly-unused-image',
        severity: 'info',
        title: 'Possibly unused image',
        description: `Image (hash ${usage.hash.slice(
          0,
          10
        )}…) is only used by layer(s) that are hidden or far off-canvas. Approximate heuristic — Figma has no real "asset library" separate from layer fills, so this is inferred from usage context, not a hard fact. Verify before deleting.`,
        node: firstNode ? toNodeRef(firstNode) : undefined,
        meta,
        autoFixable: false,
      });
    }
  }

  return { duplicates, large, possiblyUnused };
}
