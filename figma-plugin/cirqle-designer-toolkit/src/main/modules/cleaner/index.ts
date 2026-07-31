import type { HandlerContext } from '../../bridge';
import type { RunScope } from '@shared/types';
import { generateId } from '@shared/id';
import { loadJSON, saveJSON } from '../../utils/storage';
import { processInChunks } from '../../utils/chunk';
import { logger } from '../../utils/logger';
import { recordHistory } from '../system';
import { scanCleaner, type CleanerMode, type CleanerScanResult } from './cleanerScan';

/** Local storage key for the "ignore this issue on this node" list. Kept
 * local to this module rather than added to shared STORAGE_KEYS, since it's
 * a cleaner-specific implementation detail no other module reads. Value is
 * a JSON array of `${ruleId}:${nodeId}` strings. */
const CLEANER_IGNORED_KEY = 'cdt:cleaner-ignored';

function ignoreKey(ruleId: string, nodeId: string): string {
  return `${ruleId}:${nodeId}`;
}

async function loadIgnoredSet(): Promise<Set<string>> {
  const list = await loadJSON<string[]>(CLEANER_IGNORED_KEY, []);
  return new Set(list);
}

function nodePageOf(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return (current as PageNode | null) ?? null;
}

async function switchToPageOf(node: SceneNode): Promise<void> {
  const page = nodePageOf(node);
  if (!page || figma.currentPage.id === page.id) return;
  // Dynamic-page document access (see manifest.json) requires a page to be
  // loaded before it can be assigned to figma.currentPage.
  const loadable = page as unknown as { loadAsync?: () => Promise<void> };
  if (typeof loadable.loadAsync === 'function') {
    await loadable.loadAsync();
  }
  figma.currentPage = page;
}

async function resolveNodesById(ids: string[]): Promise<{ nodes: SceneNode[]; missing: string[] }> {
  const nodes: SceneNode[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.removed || node.type === 'PAGE' || node.type === 'DOCUMENT') {
      missing.push(id);
      continue;
    }
    nodes.push(node as SceneNode);
  }
  return { nodes, missing };
}

/**
 * Figma only supports a selection on the *current* page. If the requested
 * ids span multiple pages we switch to the page of the first resolved node
 * and select whichever of the requested nodes also live there — nodes on
 * other pages are reported back as unselected via `missing` being smaller
 * than the "not selected" set (see the returned counts). This is a known,
 * documented limitation of a single-page selection model, not a bug.
 */
async function handleSelect(payload: { nodeIds: string[] }): Promise<{ selectedCount: number; missing: string[] }> {
  const { nodes, missing } = await resolveNodesById(payload.nodeIds);
  if (nodes.length === 0) {
    figma.currentPage.selection = [];
    return { selectedCount: 0, missing };
  }

  const first = nodes[0];
  if (first) await switchToPageOf(first);

  const currentPageId = figma.currentPage.id;
  const onCurrentPage = nodes.filter((n) => nodePageOf(n)?.id === currentPageId);

  figma.currentPage.selection = onCurrentPage;
  if (onCurrentPage.length > 0) {
    figma.viewport.scrollAndZoomIntoView(onCurrentPage);
  }

  return { selectedCount: onCurrentPage.length, missing };
}

/**
 * Delete is intentionally NOT undoable. Figma's Plugin API has no generic
 * way to serialize an arbitrary node (styles, fills, effects, component
 * overrides, vector geometry, text runs, ...) and reconstruct it later —
 * faking "undo" with a partial recreation would silently lose data. So the
 * history entry for this action is always recorded with `undoable: false`,
 * and RenamePage/CleanerPage never render an Undo control for it; the
 * History tab is the honest record of what was removed.
 */
async function handleDelete(payload: { nodeIds: string[] }, ctx: HandlerContext): Promise<{ deletedCount: number; missing: string[] }> {
  const { nodes, missing } = await resolveNodesById(payload.nodeIds);

  const deletedIds: string[] = [];
  await processInChunks(
    nodes,
    (node) => {
      if (node.removed) return;
      const id = node.id;
      node.remove();
      deletedIds.push(id);
    },
    {
      chunkSize: 250,
      signal: ctx.signal,
      onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Deleting…' }),
    }
  );

  await recordHistory(
    {
      id: generateId('hist'),
      module: 'cleaner',
      action: 'delete',
      summary: `Deleted ${deletedIds.length} layer${deletedIds.length === 1 ? '' : 's'}`,
      timestamp: Date.now(),
      affectedNodeIds: deletedIds,
      undoable: false,
    },
    100
  );

  logger.info(`cleaner.delete: removed ${deletedIds.length} nodes`);

  return { deletedCount: deletedIds.length, missing };
}

async function handleIgnore(payload: { nodeId: string; ruleId: string }): Promise<{ ok: boolean }> {
  const list = await loadJSON<string[]>(CLEANER_IGNORED_KEY, []);
  const key = ignoreKey(payload.ruleId, payload.nodeId);
  if (!list.includes(key)) {
    list.push(key);
    await saveJSON(CLEANER_IGNORED_KEY, list);
  }
  return { ok: true };
}

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'scan': {
      const p = payload as { scope: RunScope['scope']; mode: CleanerMode };
      const ignored = await loadIgnoredSet();
      const result: CleanerScanResult = await scanCleaner(p.scope, p.mode, ctx, (ruleId, nodeId) =>
        ignored.has(ignoreKey(ruleId, nodeId))
      );
      return result;
    }
    case 'select':
      return handleSelect(payload as { nodeIds: string[] });
    case 'delete':
      return handleDelete(payload as { nodeIds: string[] }, ctx);
    case 'ignore':
      return handleIgnore(payload as { nodeId: string; ruleId: string });
    case 'clearIgnored':
      await saveJSON<string[]>(CLEANER_IGNORED_KEY, []);
      return { ok: true };
    default:
      throw new Error(`cleaner: unknown action "${action}"`);
  }
}
