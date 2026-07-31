/**
 * Mutating Component Manager actions: swap instances onto a new main
 * component, bulk-update a variant property across instances, and batch
 * relink instances per an { oldComponentId: newComponentId } mapping.
 */
import type { HandlerContext } from '../../bridge';
import type { RunScope } from '@shared/types';
import { getNodeById, collectNodes } from '../../utils/traversal';
import { processInChunks, processInChunksAsync } from '../../utils/chunk';
import { resolveMainComponent } from './componentScan';

export interface BulkOpFailure {
  id: string;
  reason: string;
}

export interface BulkOpResult {
  affected: string[];
  failed: BulkOpFailure[];
}

/**
 * API note: the officially documented, stable method for swapping an
 * instance's main component is the synchronous `InstanceNode.swapComponent
 * (component)`. We have not found a real `swapComponentAsync` in the
 * shipped @figma/plugin-typings at the time of writing, but Figma has been
 * steadily adding `...Async` twins of component/instance APIs to support
 * dynamic-page documents (getMainComponentAsync, getComponentSetAsync,
 * …), so we feature-detect for one defensively — in case a newer editor
 * build/typings version adds it — before falling back to the sync method,
 * and finally to a direct `.mainComponent = target` assignment for very old
 * runtimes. Every attempt is wrapped in try/catch and failures are reported
 * per-node instead of aborting the whole batch.
 */
type InstanceLike = InstanceNode & {
  swapComponentAsync?: (component: ComponentNode) => Promise<void>;
  getMainComponentAsync?: () => Promise<ComponentNode | null>;
};

async function swapOne(instance: InstanceLike, target: ComponentNode): Promise<void> {
  if (typeof instance.swapComponentAsync === 'function') {
    await instance.swapComponentAsync(target);
    return;
  }
  if (typeof instance.swapComponent === 'function') {
    instance.swapComponent(target);
    return;
  }
  instance.mainComponent = target;
}

function resolveComponentTarget(componentId: string): ComponentNode | null {
  const node = getNodeById(componentId);
  if (!node) return null;
  if (node.type === 'COMPONENT') return node;
  if (node.type === 'COMPONENT_SET') return node.defaultVariant;
  return null;
}

export async function swapInstances(
  instanceIds: string[],
  targetComponentId: string,
  ctx: HandlerContext
): Promise<BulkOpResult> {
  const target = resolveComponentTarget(targetComponentId);
  if (!target) {
    return {
      affected: [],
      failed: instanceIds.map((id) => ({ id, reason: `Target component "${targetComponentId}" could not be resolved.` })),
    };
  }

  const failed: BulkOpFailure[] = [];
  const affected = await processInChunksAsync(
    instanceIds,
    async (id) => {
      const node = getNodeById(id);
      if (!node || node.type !== 'INSTANCE') {
        failed.push({ id, reason: 'Node not found or is not an instance.' });
        return undefined;
      }
      try {
        await swapOne(node as InstanceLike, target);
        return id;
      } catch (err) {
        failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Swapping instances…' }) }
  );

  return { affected, failed };
}

/**
 * `setProperties` is the modern variant-property API and is only valid for
 * instances that belong to a component set exposing the given property —
 * calling it on a plain (non-variant) instance, or with an unknown property
 * name/value, throws. We therefore always wrap per-node and report
 * failures individually instead of letting one bad row abort the batch.
 */
export async function bulkUpdateVariantProperty(
  instanceIds: string[],
  property: string,
  value: string,
  ctx: HandlerContext
): Promise<BulkOpResult> {
  const failed: BulkOpFailure[] = [];
  const affected = await processInChunks(
    instanceIds,
    (id) => {
      const node = getNodeById(id);
      if (!node || node.type !== 'INSTANCE') {
        failed.push({ id, reason: 'Node not found or is not an instance.' });
        return undefined;
      }
      try {
        node.setProperties({ [property]: value });
        return id;
      } catch (err) {
        failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Updating variant property…' }) }
  );

  return { affected, failed };
}

/** Walks every INSTANCE in `scope` and, for any whose *current* main
 * component id is a key in `mapping`, swaps it to the mapped target
 * component id. Useful for "replace component A with component B
 * everywhere" after a library restructure. */
export async function batchRelink(
  mapping: Record<string, string>,
  scope: RunScope['scope'],
  ctx: HandlerContext
): Promise<BulkOpResult> {
  const instances = await collectNodes(scope, (n) => n.type === 'INSTANCE', {
    signal: ctx.signal,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Collecting instances…' }),
  });

  const failed: BulkOpFailure[] = [];
  const affected = await processInChunksAsync(
    instances,
    async (node) => {
      const instance = node as InstanceLike;
      const currentMain = await resolveMainComponent(instance);
      const currentId = currentMain?.id;
      if (!currentId) return undefined;

      const targetId = mapping[currentId];
      if (!targetId) return undefined; // not in the mapping, leave untouched

      const target = resolveComponentTarget(targetId);
      if (!target) {
        failed.push({ id: instance.id, reason: `Mapped target "${targetId}" for current component "${currentId}" could not be resolved.` });
        return undefined;
      }
      try {
        await swapOne(instance, target);
        return instance.id;
      } catch (err) {
        failed.push({ id: instance.id, reason: err instanceof Error ? err.message : String(err) });
        return undefined;
      }
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Relinking components…' }) }
  );

  return { affected, failed };
}
