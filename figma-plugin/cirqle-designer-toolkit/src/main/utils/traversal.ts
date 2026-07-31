import type { RunScope, NodeRef } from '@shared/types';
import { processInChunks, type ChunkOptions } from './chunk';

/** Resolve a run scope ('selection' | 'page' | 'document') to the actual
 * root nodes to walk from. Document scope walks every page — callers should
 * expect this to be slow on huge multi-page files and always pass chunk
 * options with a progress callback. */
export function resolveScopeRoots(scope: RunScope['scope']): readonly SceneNode[] {
  if (scope === 'selection') return figma.currentPage.selection;
  if (scope === 'page') return figma.currentPage.children;
  // 'document'
  const roots: SceneNode[] = [];
  for (const page of figma.root.children) {
    roots.push(...page.children);
  }
  return roots;
}

/** Flatten a scope into every descendant node (depth-first), chunked so the
 * UI thread never blocks on large trees. `predicate` can filter early to
 * avoid allocating a NodeRef for nodes the caller doesn't care about. */
export async function collectNodes(
  scope: RunScope['scope'],
  predicate: (node: SceneNode) => boolean = () => true,
  options: ChunkOptions = {}
): Promise<SceneNode[]> {
  const collected: SceneNode[] = [];
  const stack: SceneNode[] = [...resolveScopeRoots(scope)];
  let visited = 0;

  while (stack.length > 0) {
    if (options.signal?.cancelled) break;
    const node = stack.pop() as SceneNode;
    visited += 1;

    if (predicate(node)) collected.push(node);

    if ('children' in node) {
      const kids = (node as ChildrenMixin & SceneNode).children;
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as SceneNode);
    }

    if (visited % (options.chunkSize ?? 250) === 0) {
      options.onProgress?.(visited, visited + stack.length);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  options.onProgress?.(visited, visited);
  return collected;
}

export function toNodeRef(node: SceneNode, depth = 0): NodeRef {
  const page = node.type === 'PAGE' ? (node as unknown as PageNode) : findPage(node);
  const box = 'width' in node ? node : undefined;
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    pageId: page?.id ?? figma.currentPage.id,
    pageName: page?.name ?? figma.currentPage.name,
    parentId: node.parent?.id ?? null,
    parentName: node.parent?.name ?? null,
    depth,
    width: box ? (box as LayoutMixin & SceneNode).width : undefined,
    height: box ? (box as LayoutMixin & SceneNode).height : undefined,
    x: 'x' in node ? (node as LayoutMixin & SceneNode).x : undefined,
    y: 'y' in node ? (node as LayoutMixin & SceneNode).y : undefined,
    visible: 'visible' in node ? node.visible : true,
  };
}

function findPage(node: BaseNode): PageNode | null {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return (current as PageNode) ?? null;
}

/** Map + chunk convenience: walk a scope and produce NodeRefs directly. */
export async function collectNodeRefs(
  scope: RunScope['scope'],
  predicate: (node: SceneNode) => boolean = () => true,
  options: ChunkOptions = {}
): Promise<NodeRef[]> {
  const nodes = await collectNodes(scope, predicate, options);
  return processInChunks(nodes, (n) => toNodeRef(n), options);
}

export function getNodeById(id: string): SceneNode | null {
  const node = figma.getNodeById(id);
  if (!node || node.removed) return null;
  return node as SceneNode;
}
