/**
 * Component Manager scan: detached/broken instances, unused components, and
 * heuristically-duplicate components. All three passes are chunked (via
 * utils/chunk.ts) and progress-reported through HandlerContext, since a
 * document-wide instance walk is the single most expensive thing this
 * module does.
 */
import type { HandlerContext } from '../../bridge';
import type { Issue, RunScope } from '@shared/types';
import { generateId } from '@shared/id';
import { processInChunks, processInChunksAsync } from '../../utils/chunk';
import { collectNodes, toNodeRef } from '../../utils/traversal';

export interface UnusedComponentMeta {
  isVariantSet: boolean;
  variantCount?: number;
}

export interface DuplicateComponentMeta {
  nodeIds: string[];
  fingerprint: string;
}

export interface ComponentScanResult {
  detached: Issue[];
  unused: Issue<UnusedComponentMeta>[];
  duplicates: Issue<DuplicateComponentMeta>[];
}

/**
 * Try the async main-component lookup first — this is the one that behaves
 * correctly in dynamic-page documents, where a page (and therefore a
 * component living on it) may not be loaded into memory yet, and the
 * synchronous `.mainComponent` getter can return stale/null data or throw
 * in that situation. Older Figma runtimes/typings may not expose
 * `getMainComponentAsync`, so we feature-detect before falling back to the
 * sync property. Both paths are wrapped in try/catch because a genuinely
 * detached/broken instance can throw here rather than just resolve to null.
 */
export async function resolveMainComponent(instance: InstanceNode): Promise<ComponentNode | null> {
  const withAsync = instance as InstanceNode & { getMainComponentAsync?: () => Promise<ComponentNode | null> };
  try {
    if (typeof withAsync.getMainComponentAsync === 'function') {
      return await withAsync.getMainComponentAsync();
    }
    return instance.mainComponent;
  } catch {
    return null;
  }
}

/**
 * NOTE on "detached" vs "broken": the Plugin API has no marker that tells
 * you an instance was detached via the "Detach Instance" command versus its
 * main component having been deleted/unpublished out from under it — both
 * situations simply resolve to a null/unresolvable main component when you
 * read it. We therefore treat "detached" and "broken" as one signal and
 * report a single issue type for both.
 */
async function scanDetachedOrBroken(scope: RunScope['scope'], ctx: HandlerContext): Promise<Issue[]> {
  const instances = await collectNodes(scope, (n) => n.type === 'INSTANCE', {
    signal: ctx.signal,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Collecting instances…' }),
  });

  return processInChunksAsync(
    instances,
    async (node) => {
      const instance = node as InstanceNode;
      const main = await resolveMainComponent(instance);
      if (main) return undefined;
      const issue: Issue = {
        id: generateId('issue'),
        ruleId: 'componentManager/detached-or-broken-instance',
        severity: 'warning',
        title: 'Detached or broken instance',
        description: `"${instance.name}" has no resolvable main component (either detached, or its source component was deleted/unpublished).`,
        node: toNodeRef(instance),
        autoFixable: false,
      };
      return issue;
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Checking instances for broken links…' }) }
  );
}

/** Builds componentId -> instance-usage-count across the ENTIRE document,
 * regardless of the scan's scope — an instance anywhere in the file keeps a
 * component "used". This is the expensive pass: every instance in every
 * page has to be walked and have its main component resolved. */
async function buildDocumentWideUsageMap(ctx: HandlerContext): Promise<Map<string, number>> {
  const allInstances = await collectNodes('document', (n) => n.type === 'INSTANCE', {
    signal: ctx.signal,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Scanning document for instances (unused-component check)…' }),
  });

  const usage = new Map<string, number>();
  await processInChunksAsync(
    allInstances,
    async (node) => {
      const instance = node as InstanceNode;
      const main = await resolveMainComponent(instance);
      if (!main) return undefined;
      usage.set(main.id, (usage.get(main.id) ?? 0) + 1);
      return undefined;
    },
    {
      chunkSize: 100,
      signal: ctx.signal,
      onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Counting component usage document-wide…' }),
    }
  );

  return usage;
}

async function scanUnusedComponents(ctx: HandlerContext): Promise<Issue<UnusedComponentMeta>[]> {
  const usage = await buildDocumentWideUsageMap(ctx);

  const allComponents = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
  const allComponentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });

  // Design decision (documented per the task brief): a COMPONENT node whose
  // parent is a COMPONENT_SET is a *variant*, not a standalone component.
  // Reporting each unused variant individually is noisy — many variants in
  // a well-formed set are never instantiated directly (instances are always
  // created from the set, picking a variant via properties), so a variant
  // showing zero direct instance references doesn't necessarily mean it's
  // unused. Instead we roll variants up to the set level: a COMPONENT_SET
  // is only reported "unused" if NONE of its variants have any instances
  // anywhere in the document. Standalone components (not part of a set)
  // are still reported individually, at the component level.
  const setIssues = await processInChunks<ComponentSetNode, Issue<UnusedComponentMeta>>(
    allComponentSets,
    (set) => {
      const variants = set.children.filter((c): c is ComponentNode => c.type === 'COMPONENT');
      const totalUsage = variants.reduce((sum, v) => sum + (usage.get(v.id) ?? 0), 0);
      if (totalUsage > 0) return undefined;
      return {
        id: generateId('issue'),
        ruleId: 'componentManager/unused-component-set',
        severity: 'info',
        title: 'Unused component set',
        description: `"${set.name}" (${variants.length} variant${variants.length === 1 ? '' : 's'}) has no instances anywhere in the document.`,
        node: toNodeRef(set),
        meta: { isVariantSet: true, variantCount: variants.length },
        autoFixable: false,
      };
    },
    { signal: ctx.signal }
  );

  const standaloneComponents = allComponents.filter((c) => c.parent?.type !== 'COMPONENT_SET');
  const standaloneIssues = await processInChunks<ComponentNode, Issue<UnusedComponentMeta>>(
    standaloneComponents,
    (comp) => {
      const count = usage.get(comp.id) ?? 0;
      if (count > 0) return undefined;
      return {
        id: generateId('issue'),
        ruleId: 'componentManager/unused-component',
        severity: 'info',
        title: 'Unused component',
        description: `"${comp.name}" has no instances anywhere in the document.`,
        node: toNodeRef(comp),
        meta: { isVariantSet: false },
        autoFixable: false,
      };
    },
    { signal: ctx.signal }
  );

  return [...setIssues, ...standaloneIssues];
}

function fingerprint(node: ComponentNode | ComponentSetNode, childCount: number): string {
  const w = Math.round(node.width);
  const h = Math.round(node.height);
  return `${node.name}::${w}x${h}::${childCount}`;
}

/**
 * Heuristic duplicate detection — NOT byte-identical / pixel-identical
 * comparison. Two components are grouped together purely on name + rounded
 * bounding-box size + immediate child count. This is a fast first pass
 * meant to point a human at candidates worth reviewing, not an authoritative
 * "these are duplicates" verdict: it will produce false positives (two
 * differently-styled icons that happen to share a name/size/child count)
 * and false negatives (visually identical components with different names
 * or a stray extra child).
 */
async function scanDuplicateComponents(ctx: HandlerContext): Promise<Issue<DuplicateComponentMeta>[]> {
  const allComponents = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
  const allComponentSets = figma.root.findAllWithCriteria({ types: ['COMPONENT_SET'] });

  interface Unit {
    node: ComponentNode | ComponentSetNode;
    key: string;
  }

  const setUnits = await processInChunks<ComponentSetNode, Unit>(
    allComponentSets,
    (set) => ({ node: set, key: fingerprint(set, set.children.length) }),
    { signal: ctx.signal }
  );

  const standaloneComponents = allComponents.filter((c) => c.parent?.type !== 'COMPONENT_SET');
  const componentUnits = await processInChunks<ComponentNode, Unit>(
    standaloneComponents,
    (comp) => ({ node: comp, key: fingerprint(comp, comp.children.length) }),
    { signal: ctx.signal }
  );

  const groups = new Map<string, Unit[]>();
  for (const unit of [...setUnits, ...componentUnits]) {
    const list = groups.get(unit.key) ?? [];
    list.push(unit);
    groups.set(unit.key, list);
  }

  const issues: Issue<DuplicateComponentMeta>[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    issues.push({
      id: generateId('issue'),
      ruleId: 'componentManager/duplicate-component-heuristic',
      severity: 'info',
      title: `${group.length} components look like duplicates`,
      description: `Same name, size and child count (fingerprint "${key}") — heuristic only, review before merging.`,
      meta: { nodeIds: group.map((u) => u.node.id), fingerprint: key },
      autoFixable: false,
    });
  }
  return issues;
}

export async function scanComponents(scope: RunScope['scope'], ctx: HandlerContext): Promise<ComponentScanResult> {
  const detached = await scanDetachedOrBroken(scope, ctx);
  if (ctx.signal.cancelled) return { detached, unused: [], duplicates: [] };

  const unused = await scanUnusedComponents(ctx);
  if (ctx.signal.cancelled) return { detached, unused, duplicates: [] };

  const duplicates = await scanDuplicateComponents(ctx);
  return { detached, unused, duplicates };
}
