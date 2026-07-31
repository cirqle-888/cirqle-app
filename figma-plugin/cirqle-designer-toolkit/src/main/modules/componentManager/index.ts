import type { HandlerContext } from '../../bridge';
import type { RunScope } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';
import { STORAGE_KEYS } from '@shared/constants';
import { generateId } from '@shared/id';
import { loadJSON } from '../../utils/storage';
import { recordHistory } from '../system';
import { scanComponents } from './componentScan';
import { swapInstances, bulkUpdateVariantProperty, batchRelink, type BulkOpResult } from './componentActions';

async function historyCap(): Promise<number> {
  const settings = await loadJSON(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  return settings.keepHistoryCount;
}

function toOperationResult(result: BulkOpResult, start: number) {
  return {
    ok: result.failed.length === 0,
    data: result,
    warnings: result.failed.map((f) => `${f.id}: ${f.reason}`),
    durationMs: Date.now() - start,
    affectedCount: result.affected.length,
  };
}

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'scan': {
      const { scope } = payload as RunScope;
      return scanComponents(scope, ctx);
    }

    case 'swapInstances': {
      const start = Date.now();
      const { instanceIds, targetComponentId } = payload as { instanceIds: string[]; targetComponentId: string };
      const result = await swapInstances(instanceIds, targetComponentId, ctx);
      if (result.affected.length > 0) {
        await recordHistory(
          {
            id: generateId('hist'),
            module: 'componentManager',
            action: 'swapInstances',
            summary: `Swapped ${result.affected.length} instance(s) to component ${targetComponentId}${result.failed.length ? ` (${result.failed.length} failed)` : ''}.`,
            timestamp: Date.now(),
            affectedNodeIds: result.affected,
            undoable: false,
          },
          await historyCap()
        );
      }
      return toOperationResult(result, start);
    }

    case 'bulkUpdateVariant': {
      const start = Date.now();
      const { instanceIds, property, value } = payload as { instanceIds: string[]; property: string; value: string };
      const result = await bulkUpdateVariantProperty(instanceIds, property, value, ctx);
      if (result.affected.length > 0) {
        await recordHistory(
          {
            id: generateId('hist'),
            module: 'componentManager',
            action: 'bulkUpdateVariant',
            summary: `Set "${property}" = "${value}" on ${result.affected.length} instance(s)${result.failed.length ? ` (${result.failed.length} failed)` : ''}.`,
            timestamp: Date.now(),
            affectedNodeIds: result.affected,
            undoable: false,
          },
          await historyCap()
        );
      }
      return toOperationResult(result, start);
    }

    case 'batchRelink': {
      const start = Date.now();
      const { mapping, scope } = payload as { mapping: Record<string, string>; scope: RunScope['scope'] };
      const result = await batchRelink(mapping, scope, ctx);
      if (result.affected.length > 0) {
        await recordHistory(
          {
            id: generateId('hist'),
            module: 'componentManager',
            action: 'batchRelink',
            summary: `Relinked ${result.affected.length} instance(s) per ${Object.keys(mapping).length} mapping(s)${result.failed.length ? ` (${result.failed.length} failed)` : ''}.`,
            timestamp: Date.now(),
            affectedNodeIds: result.affected,
            undoable: false,
          },
          await historyCap()
        );
      }
      return toOperationResult(result, start);
    }

    // Not in the original required action list, but listed as a "nice to
    // have if there's time" in the brief — powers an optional dropdown of
    // local components in the UI, alongside the always-available text-input
    // fallback for target component id/key.
    case 'listLocalComponents': {
      const components = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
      return components
        .filter((c) => c.parent?.type !== 'COMPONENT_SET')
        .map((c) => ({ id: c.id, name: c.name, key: c.key }));
    }

    default:
      throw new Error(`componentManager: unknown action "${action}"`);
  }
}
