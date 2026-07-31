import type { HandlerContext } from '../../bridge';
import type { RunScope } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { STORAGE_KEYS } from '@shared/constants';
import { generateId } from '@shared/id';
import { loadJSON } from '../../utils/storage';
import { recordHistory } from '../system';
import { getNodeById } from '../../utils/traversal';
import { processInChunks } from '../../utils/chunk';
import { scanAssets } from './assetScan';
import { getImagePaints, type ImagePaintSource } from './imageHash';

async function historyCap(): Promise<number> {
  const settings = await loadJSON(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  return settings.keepHistoryCount;
}

/** Simple {n}/{nn}-numbered rename for the layers that hold selected image
 * fills. Deliberately NOT importing the Rename module — Asset Manager stays
 * self-contained and only needs this one small numbering pattern, not the
 * full rename engine (regex, smart variables, find/replace, etc). */
function applyNamePattern(pattern: string, index: number): string {
  const n = String(index + 1);
  const nn = n.padStart(2, '0');
  // split/join instead of String.prototype.replaceAll — this project's
  // tsconfig lib is ES2020, which predates replaceAll (ES2021).
  return pattern.split('{nn}').join(nn).split('{n}').join(n);
}

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'scan': {
      const { scope } = payload as RunScope;
      return scanAssets(scope, ctx);
    }

    case 'renameAssetNodes': {
      const start = Date.now();
      const { nodeIds, pattern } = payload as { nodeIds: string[]; pattern: string };
      const failed: string[] = [];
      const affected = await processInChunks(
        nodeIds,
        (id, index) => {
          const node = getNodeById(id);
          if (!node) {
            failed.push(id);
            return undefined;
          }
          node.name = applyNamePattern(pattern, index);
          return id;
        },
        { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Renaming asset layers…' }) }
      );

      if (affected.length > 0) {
        await recordHistory(
          {
            id: generateId('hist'),
            module: 'assetManager',
            action: 'renameAssetNodes',
            summary: `Renamed ${affected.length} asset layer(s) using pattern "${pattern}".`,
            timestamp: Date.now(),
            affectedNodeIds: affected,
            undoable: false,
          },
          await historyCap()
        );
      }

      return { ok: failed.length === 0, data: { affected, failed }, durationMs: Date.now() - start, affectedCount: affected.length };
    }

    case 'getImageForRoundTrip': {
      const { nodeId, property, paintIndex } = payload as { nodeId: string; property: ImagePaintSource; paintIndex: number };
      const node = getNodeById(nodeId);
      if (!node) throw new Error(`Node "${nodeId}" not found.`);

      const ref = getImagePaints(node).find((r) => r.property === property && r.paintIndex === paintIndex);
      if (!ref) throw new Error(`No IMAGE paint at ${property}[${paintIndex}] on node "${nodeId}".`);

      const image = figma.getImageByHash(ref.imageHash);
      if (!image) throw new Error(`Image hash "${ref.imageHash}" could not be resolved.`);

      const bytes = await image.getBytesAsync();
      return { bytes, hash: ref.imageHash };
    }

    case 'applyImageBytes': {
      const start = Date.now();
      const { nodeId, property, paintIndex, bytes } = payload as {
        nodeId: string;
        property: ImagePaintSource;
        paintIndex: number;
        bytes: Uint8Array;
      };
      const node = getNodeById(nodeId);
      if (!node) throw new Error(`Node "${nodeId}" not found.`);

      // Uint8Array survives the postMessage structured-clone boundary
      // between the UI iframe and this sandbox, so `bytes` here is already
      // a real typed array — no manual re-encoding needed.
      const image = figma.createImage(bytes);

      const carrier = node as unknown as { fills?: ReadonlyArray<Paint>; strokes?: ReadonlyArray<Paint> };
      const currentPaints = property === 'fills' ? carrier.fills : carrier.strokes;
      const currentPaint = currentPaints?.[paintIndex];
      if (!currentPaint || currentPaint.type !== 'IMAGE') {
        throw new Error(`No IMAGE paint at ${property}[${paintIndex}] on node "${nodeId}".`);
      }

      // Paint arrays are immutable from the plugin API's point of view —
      // you must assign a brand new array back to `fills`/`strokes` rather
      // than mutating an entry in place.
      const nextPaints = currentPaints.map((p, i) => (i === paintIndex ? { ...p, imageHash: image.hash } : p));
      (node as unknown as { fills: Paint[]; strokes: Paint[] })[property] = nextPaints as Paint[];

      await recordHistory(
        {
          id: generateId('hist'),
          module: 'assetManager',
          action: 'applyImageBytes',
          summary: `Replaced image at ${property}[${paintIndex}] on "${node.name}" (new hash ${image.hash.slice(0, 10)}…).`,
          timestamp: Date.now(),
          affectedNodeIds: [nodeId],
          undoable: false,
        },
        await historyCap()
      );

      return { ok: true, data: { hash: image.hash }, durationMs: Date.now() - start, affectedCount: 1 };
    }

    default:
      throw new Error(`assetManager: unknown action "${action}"`);
  }
}
