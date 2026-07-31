import type { HandlerContext } from '../../bridge';
import { logger } from '../../utils/logger';
import { generateId } from '@shared/id';
import { collectNodes } from '../../utils/traversal';
import { processInChunks } from '../../utils/chunk';
import { recordHistory } from '../system';
import { buildNewName, formatDateYYYYMMDD, type RenameContext } from './renameEngine';
import type {
  NodeTypeFilterKey,
  RenameApplyResult,
  RenamePayload,
  RenamePreviewResult,
  RenamePreviewRow,
  RenameRule,
  RenameUndoPayload,
} from './renameTypes';

/** See the NodeTypeFilterKey doc comment in renameTypes.ts for the full
 * key -> Figma-node mapping this implements. */
function hasImageFill(node: SceneNode): boolean {
  if (!('fills' in node)) return false;
  const fills = (node as unknown as { fills: readonly Paint[] | typeof figma.mixed }).fills;
  if (fills === figma.mixed || !Array.isArray(fills)) return false;
  return fills.some((paint) => paint.type === 'IMAGE' && paint.visible !== false);
}

function matchesTypeFilter(node: SceneNode, filter: NodeTypeFilterKey[]): boolean {
  if (filter.length === 0) return true;
  return filter.some((key) => {
    switch (key) {
      case 'FRAME':
        return node.type === 'FRAME';
      case 'COMPONENT':
        return node.type === 'COMPONENT' || node.type === 'COMPONENT_SET';
      case 'INSTANCE':
        return node.type === 'INSTANCE';
      case 'GROUP':
        return node.type === 'GROUP';
      case 'TEXT':
        return node.type === 'TEXT';
      case 'VECTOR':
        return node.type === 'VECTOR';
      case 'SECTION':
        return node.type === 'SECTION';
      case 'IMAGE':
        return hasImageFill(node);
      default:
        return false;
    }
  });
}

function nodePageName(node: SceneNode): string {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return (current as PageNode | null)?.name ?? figma.currentPage.name;
}

async function resolveNodes(payload: RenamePayload, ctx: HandlerContext): Promise<SceneNode[]> {
  return collectNodes(payload.scope, (node) => matchesTypeFilter(node, payload.typeFilter), {
    chunkSize: 250,
    signal: ctx.signal,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Scanning layers…' }),
  });
}

async function computePreviewRows(
  nodes: SceneNode[],
  rule: RenameRule,
  ctx: HandlerContext
): Promise<RenamePreviewRow[]> {
  const date = formatDateYYYYMMDD(new Date());
  const batchCount = nodes.length;

  return processInChunks(
    nodes,
    (node, i) => {
      const context: RenameContext = {
        type: node.type,
        parent: node.parent?.name ?? '',
        page: nodePageName(node),
        date,
        batchCount,
      };
      const result = buildNewName(node.name, i, context, rule);
      const row: RenamePreviewRow = result.ok
        ? { id: node.id, oldName: node.name, newName: result.name }
        : { id: node.id, oldName: node.name, newName: node.name, error: result.error };
      return row;
    },
    {
      chunkSize: 250,
      signal: ctx.signal,
      onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Building preview…' }),
    }
  );
}

// ---------------------------------------------------------------------------
// In-memory, main-thread-only undo stack. Deliberately NOT persisted to
// clientStorage: it holds live SceneNode references (not just ids) so undo
// never has to worry about dynamic-page node loading — it's lost when the
// plugin closes, which is an accepted, documented limitation (see History
// tab / HistoryEntry.undoable for the durable audit trail instead).
// ---------------------------------------------------------------------------
interface UndoEntry {
  token: string;
  revert: () => void | Promise<void>;
}

const UNDO_CAP = 20;
const undoStack: UndoEntry[] = [];

function pushUndo(token: string, revert: UndoEntry['revert']): void {
  undoStack.push({ token, revert });
  while (undoStack.length > UNDO_CAP) undoStack.shift();
}

async function handleApply(payload: RenamePayload, ctx: HandlerContext): Promise<RenameApplyResult> {
  const nodes = await resolveNodes(payload, ctx);
  const rows = await computePreviewRows(nodes, payload.rule, ctx);
  const idToNode = new Map(nodes.map((n) => [n.id, n] as const));

  const undoEntries: Array<{ node: SceneNode; oldName: string }> = [];
  const errors: Array<{ id: string; error: string }> = [];

  await processInChunks(
    rows,
    (row) => {
      if (row.error) {
        errors.push({ id: row.id, error: row.error });
        return;
      }
      const node = idToNode.get(row.id);
      if (!node || node.removed) {
        errors.push({ id: row.id, error: 'Node no longer exists' });
        return;
      }
      if (node.name === row.newName) return; // no-op, nothing to rename or undo

      const oldName = node.name;
      node.name = row.newName;
      undoEntries.push({ node, oldName });
    },
    {
      chunkSize: 250,
      signal: ctx.signal,
      onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Renaming…' }),
    }
  );

  let undoToken: string | undefined;
  if (undoEntries.length > 0) {
    undoToken = generateId('undo');
    pushUndo(undoToken, () => {
      for (const entry of undoEntries) {
        if (!entry.node.removed) entry.node.name = entry.oldName;
      }
    });
  }

  await recordHistory(
    {
      id: generateId('hist'),
      module: 'rename',
      action: 'apply',
      summary: `Renamed ${undoEntries.length} layer${undoEntries.length === 1 ? '' : 's'}${
        errors.length ? ` (${errors.length} skipped)` : ''
      }`,
      timestamp: Date.now(),
      affectedNodeIds: undoEntries.map((e) => e.node.id),
      undoable: undoEntries.length > 0,
    },
    100
  );

  logger.info(`rename.apply: renamed ${undoEntries.length}, ${errors.length} errors`);

  return { renamedCount: undoEntries.length, errorCount: errors.length, errors, undoToken };
}

async function handleUndo(payload: RenameUndoPayload): Promise<{ ok: boolean }> {
  const idx = undoStack.findIndex((e) => e.token === payload.token);
  if (idx === -1) {
    throw new Error('This rename can no longer be undone (the plugin session may have ended, or the undo history capacity was exceeded).');
  }
  const removed = undoStack.splice(idx, 1)[0];
  if (!removed) {
    throw new Error('This rename can no longer be undone.');
  }
  await removed.revert();

  await recordHistory(
    {
      id: generateId('hist'),
      module: 'rename',
      action: 'undo',
      summary: 'Reverted a bulk rename',
      timestamp: Date.now(),
      affectedNodeIds: [],
      undoable: false,
    },
    100
  );

  return { ok: true };
}

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'preview': {
      const p = payload as RenamePayload;
      const nodes = await resolveNodes(p, ctx);
      const rows = await computePreviewRows(nodes, p.rule, ctx);
      const result: RenamePreviewResult = { rows, total: rows.length };
      return result;
    }
    case 'apply':
      return handleApply(payload as RenamePayload, ctx);
    case 'undo':
      return handleUndo(payload as RenameUndoPayload);
    default:
      throw new Error(`rename: unknown action "${action}"`);
  }
}
