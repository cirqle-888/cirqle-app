/**
 * The Automator action engine: one entry per ActionType, each operating on a
 * resolved SceneNode[] list. Design rules followed throughout this file:
 *
 *  - Every action is wrapped so a single bad node (wrong type, removed
 *    mid-run, API throws) is collected into `warnings` instead of aborting
 *    the whole batch — see `forEachNode` below, which is the per-node
 *    try/catch helper almost every action uses.
 *  - Any loop over the full node list goes through processInChunks /
 *    processInChunksAsync (src/main/utils/chunk.ts) so a document-scope run
 *    over thousands of nodes yields to the event loop and honours
 *    ctx.signal.cancelled, per project convention.
 *  - Params come in as `unknown` and get cast to their action-specific type
 *    from actionTypes.ts — the caller (index.ts / macroRunner.ts) is
 *    responsible for having sourced them from a UI form or a persisted
 *    macro step, so no runtime schema validation is done here beyond what
 *    each action naturally needs to not throw.
 */
import { postEvent, type HandlerContext } from '../../../bridge';
import { processInChunks, processInChunksAsync } from '../../../utils/chunk';
import type {
  ActionType,
  AlignActionParams,
  ApplyAutoLayoutActionParams,
  CreateComponentActionParams,
  DistributeActionParams,
  DuplicateActionParams,
  ExportActionParams,
  MoveActionParams,
  RenameActionParams,
  ReplaceColorActionParams,
  ReplaceFontActionParams,
  ReplaceImageActionParams,
  ResizeActionParams,
  RotateActionParams,
  RoundCornersActionParams,
  ScaleActionParams,
  SwapComponentActionParams,
  UpdateVariableActionParams,
} from './actionTypes';

export interface ActionRunResult {
  affected: number;
  warnings: string[];
}

export type ActionFn = (nodes: SceneNode[], params: unknown, ctx: HandlerContext) => Promise<ActionRunResult>;

type Positioned = SceneNode & { x: number; y: number };
type Boxed = SceneNode & { x: number; y: number; width: number; height: number };

function isBoxed(node: SceneNode): node is Boxed {
  return 'x' in node && 'y' in node && 'width' in node && 'height' in node;
}

/** Shared per-node runner: iterates `nodes` in chunks, calls `fn` for each,
 * and turns any thrown error into a `warnings` entry keyed by node id/name
 * rather than letting it propagate and kill the whole action. `fn` returns
 * `true` if it actually changed/affected the node, `false` if it legitimately
 * didn't apply (e.g. wrong node type for this action) — that still counts as
 * "handled", not a warning, unless `fn` itself throws. */
async function forEachNode(
  nodes: SceneNode[],
  ctx: HandlerContext,
  fn: (node: SceneNode, index: number) => Promise<boolean>
): Promise<ActionRunResult> {
  const warnings: string[] = [];
  let affected = 0;

  await processInChunksAsync(
    nodes,
    async (node, index) => {
      try {
        const didAffect = await fn(node, index);
        if (didAffect) affected += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        let label = node.id;
        try {
          label = `${node.name} (${node.id})`;
        } catch {
          // Node may already be removed/detached — id-only label is fine.
        }
        warnings.push(`${label}: ${message}`);
      }
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total }) }
  );

  return { affected, warnings };
}

function hexToRgb255(hex: string): { r: number; g: number; b: number } {
  const clean = hex.trim().replace(/^#/, '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0').slice(0, 6);
  const num = parseInt(full, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function rgb255ToFigma(rgb: { r: number; g: number; b: number }): RGB {
  return { r: rgb.r / 255, g: rgb.g / 255, b: rgb.b / 255 };
}

function figmaToRgb255(color: RGB): { r: number; g: number; b: number } {
  return { r: Math.round(color.r * 255), g: Math.round(color.g * 255), b: Math.round(color.b * 255) };
}

/** Chebyshev (max-channel) distance — a single "tolerance" slider maps
 * intuitively to "each channel is within N" rather than a combined
 * Euclidean radius. */
function withinTolerance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, tolerance: number): boolean {
  return Math.abs(a.r - b.r) <= tolerance && Math.abs(a.g - b.g) <= tolerance && Math.abs(a.b - b.b) <= tolerance;
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------
const rename: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as RenameActionParams;
  const start = params.start ?? 1;
  const padding = params.padding ?? 0;

  return forEachNode(nodes, ctx, async (node, i) => {
    const n = start + i;
    const padded = padding > 0 ? String(n).padStart(padding, '0') : String(n);
    const withDoubleDigit = params.pattern.replace(/\{nn\}/g, String(n).padStart(2, '0'));
    node.name = withDoubleDigit.replace(/\{n\}/g, padded);
    return true;
  });
};

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------
const resize: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as ResizeActionParams;

  return forEachNode(nodes, ctx, async (node) => {
    if (!('resize' in node)) throw new Error(`${node.type} does not support resize`);
    const target = node as SceneNode & { resize: (w: number, h: number) => void; width: number; height: number };

    if (params.mode === 'percentage') {
      const pct = (params.percentage ?? 100) / 100;
      target.resize(Math.max(0.01, target.width * pct), Math.max(0.01, target.height * pct));
    } else {
      const w = params.width ?? target.width;
      const h = params.height ?? target.height;
      target.resize(Math.max(0.01, w), Math.max(0.01, h));
    }
    return true;
  });
};

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------
const move: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as MoveActionParams;

  return forEachNode(nodes, ctx, async (node) => {
    if (!('x' in node) || !('y' in node)) throw new Error(`${node.type} has no x/y`);
    const target = node as Positioned;
    target.x += params.dx;
    target.y += params.dy;
    return true;
  });
};

// ---------------------------------------------------------------------------
// align — relative to the combined bounding box of the whole node set
// ---------------------------------------------------------------------------
const align: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as AlignActionParams;
  const boxed = nodes.filter(isBoxed);
  if (boxed.length === 0) return { affected: 0, warnings: ['No nodes in scope support x/y/width/height.'] };

  // Manual min/max loops rather than Math.min(...array) — a document-scope
  // run can easily exceed the call-stack-safe spread size.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of boxed) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return forEachNode(nodes, ctx, async (node) => {
    if (!isBoxed(node)) throw new Error(`${node.type} has no x/y/width/height`);
    switch (params.mode) {
      case 'left':
        node.x = minX;
        break;
      case 'right':
        node.x = maxX - node.width;
        break;
      case 'center-h':
        node.x = centerX - node.width / 2;
        break;
      case 'top':
        node.y = minY;
        break;
      case 'bottom':
        node.y = maxY - node.height;
        break;
      case 'center-v':
        node.y = centerY - node.height / 2;
        break;
      default:
        throw new Error(`Unknown align mode "${String(params.mode)}"`);
    }
    return true;
  });
};

// ---------------------------------------------------------------------------
// distribute — even spacing across 3+ nodes, sorted by position
// ---------------------------------------------------------------------------
const distribute: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as DistributeActionParams;
  const boxed = nodes.filter(isBoxed);
  if (boxed.length < 3) {
    return { affected: 0, warnings: ['Distribute needs at least 3 nodes with position/size in scope.'] };
  }

  const axis = params.axis;
  const sorted = [...boxed].sort((a, b) => (axis === 'horizontal' ? a.x - b.x : a.y - b.y));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const totalSpan = axis === 'horizontal' ? last.x + last.width - first.x : last.y + last.height - first.y;

  let totalSize = 0;
  for (const n of sorted) totalSize += axis === 'horizontal' ? n.width : n.height;
  const gap = (totalSpan - totalSize) / (sorted.length - 1);

  let cursor = axis === 'horizontal' ? first.x : first.y;
  const warnings: string[] = [];
  let affected = 0;

  await processInChunks(
    sorted,
    (n) => {
      try {
        if (axis === 'horizontal') {
          n.x = cursor;
          cursor += n.width + gap;
        } else {
          n.y = cursor;
          cursor += n.height + gap;
        }
        affected += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`${n.id}: ${message}`);
      }
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total }) }
  );

  return { affected, warnings };
};

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------
const rotate: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as RotateActionParams;
  return forEachNode(nodes, ctx, async (node) => {
    if (!('rotation' in node)) throw new Error(`${node.type} does not support rotation`);
    (node as SceneNode & { rotation: number }).rotation = params.degrees;
    return true;
  });
};

// ---------------------------------------------------------------------------
// scale — proportional resize
// ---------------------------------------------------------------------------
const scale: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as ScaleActionParams;
  const factor = params.factor;

  return forEachNode(nodes, ctx, async (node) => {
    const target = node as SceneNode & {
      rescale?: (f: number) => void;
      resize?: (w: number, h: number) => void;
      width?: number;
      height?: number;
    };
    if (typeof target.rescale === 'function') {
      target.rescale(factor);
      return true;
    }
    if (typeof target.resize === 'function' && typeof target.width === 'number' && typeof target.height === 'number') {
      target.resize(Math.max(0.01, target.width * factor), Math.max(0.01, target.height * factor));
      return true;
    }
    throw new Error(`${node.type} does not support scaling`);
  });
};

// ---------------------------------------------------------------------------
// roundCorners
// ---------------------------------------------------------------------------
const roundCorners: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as RoundCornersActionParams;
  return forEachNode(nodes, ctx, async (node) => {
    if (!('cornerRadius' in node)) throw new Error(`${node.type} has no cornerRadius`);
    (node as SceneNode & { cornerRadius: number | symbol }).cornerRadius = params.radius;
    return true;
  });
};

// ---------------------------------------------------------------------------
// replaceColor — solid fills/strokes within `tolerance` of fromHex → toHex
// ---------------------------------------------------------------------------
const replaceColor: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as ReplaceColorActionParams;
  const from = hexToRgb255(params.fromHex);
  const toFigma = rgb255ToFigma(hexToRgb255(params.toHex));
  const tolerance = params.tolerance ?? 0;

  return forEachNode(nodes, ctx, async (node) => {
    let changed = false;
    const target = node as SceneNode & { fills?: Paint[] | symbol; strokes?: Paint[] | symbol };

    if (Array.isArray(target.fills)) {
      const next = target.fills.map((paint) => {
        if (paint.type === 'SOLID' && withinTolerance(figmaToRgb255(paint.color), from, tolerance)) {
          changed = true;
          return { ...paint, color: toFigma };
        }
        return paint;
      });
      if (changed) target.fills = next;
    }

    if (Array.isArray(target.strokes)) {
      let strokeChanged = false;
      const next = target.strokes.map((paint) => {
        if (paint.type === 'SOLID' && withinTolerance(figmaToRgb255(paint.color), from, tolerance)) {
          strokeChanged = true;
          return { ...paint, color: toFigma };
        }
        return paint;
      });
      if (strokeChanged) {
        target.strokes = next;
        changed = true;
      }
    }

    return changed;
  });
};

// ---------------------------------------------------------------------------
// replaceFont — Figma requires loading BOTH the old and new font before a
// fontName mutation on existing text, even though we're only writing the
// new one.
// ---------------------------------------------------------------------------
const replaceFont: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as ReplaceFontActionParams;
  const oldFont: FontName = { family: params.fromFamily, style: params.fromStyle };
  const newFont: FontName = { family: params.toFamily, style: params.toStyle };

  return forEachNode(nodes, ctx, async (node) => {
    if (node.type !== 'TEXT') return false;
    const text = node;
    if (text.fontName === figma.mixed) {
      throw new Error('Text has mixed fonts across its runs; Automator only replaces a single uniform font per node');
    }
    const current = text.fontName as FontName;
    if (current.family !== oldFont.family || current.style !== oldFont.style) return false;

    await figma.loadFontAsync(oldFont);
    await figma.loadFontAsync(newFont);
    text.fontName = newFont;
    return true;
  });
};

// ---------------------------------------------------------------------------
// replaceImage
// ---------------------------------------------------------------------------
const replaceImage: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as ReplaceImageActionParams;

  let image: Image;
  try {
    image = figma.createImage(new Uint8Array(params.imageBytes));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { affected: 0, warnings: [`Could not decode replacement image: ${message}`] };
  }

  return forEachNode(nodes, ctx, async (node) => {
    const target = node as SceneNode & { fills?: Paint[] | symbol };
    if (!Array.isArray(target.fills)) return false;

    let changed = false;
    const next = target.fills.map((paint) => {
      if (paint.type === 'IMAGE' && (!params.targetImageHash || paint.imageHash === params.targetImageHash)) {
        changed = true;
        return { ...paint, imageHash: image.hash };
      }
      return paint;
    });
    if (changed) target.fills = next;
    return changed;
  });
};

// ---------------------------------------------------------------------------
// swapComponent — try the modern async API first, fall back gracefully
// ---------------------------------------------------------------------------
const swapComponent: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as SwapComponentActionParams;
  const target = figma.getNodeById(params.targetComponentId);
  if (!target || target.removed || target.type !== 'COMPONENT') {
    return { affected: 0, warnings: [`targetComponentId "${params.targetComponentId}" is not a valid, existing component.`] };
  }
  const targetComponent = target;

  return forEachNode(nodes, ctx, async (node) => {
    if (node.type !== 'INSTANCE') throw new Error(`${node.type} is not a component instance`);
    // swapComponentAsync is the modern Plugin API (returns a Promise); some
    // older Figma desktop builds only have the synchronous mainComponent
    // setter, so fall back to that when the async method isn't present.
    if (typeof node.swapComponentAsync === 'function') {
      await node.swapComponentAsync(targetComponent);
    } else {
      node.mainComponent = targetComponent;
    }
    return true;
  });
};

// ---------------------------------------------------------------------------
// createComponent — best effort, see inline notes for what doesn't survive
// ---------------------------------------------------------------------------
const createComponent: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as CreateComponentActionParams;
  const prefix = params.namePrefix ?? '';

  return forEachNode(nodes, ctx, async (node) => {
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.type === 'INSTANCE') {
      throw new Error(`${node.type} is already a component or instance`);
    }
    const parent = node.parent;
    if (!parent) throw new Error('Node has no parent to insert the new component into');
    if (!isBoxed(node)) throw new Error(`${node.type} has no geometry to convert`);

    const indexInParent = parent.children.indexOf(node);
    const component = figma.createComponent();
    component.name = `${prefix}${node.name}`;
    component.x = node.x;
    component.y = node.y;
    component.resizeWithoutConstraints(Math.max(0.01, node.width), Math.max(0.01, node.height));

    if ('children' in node) {
      // Container node (FRAME/GROUP/etc): move its existing children into
      // the new component so the component becomes the replacement
      // container. KNOWN SIMPLIFICATION: this does NOT copy auto-layout
      // settings, constraints, clipsContent, effects, corner radius,
      // fills/strokes or blend mode from the original — only geometry and
      // children survive. A caller converting a richly-styled frame should
      // expect to re-apply those properties by hand afterwards.
      const container = node as SceneNode & ChildrenMixin;
      for (const child of [...container.children]) {
        component.appendChild(child);
      }
      parent.insertChild(indexInParent >= 0 ? indexInParent : parent.children.length, component);
      // A GROUP with zero children auto-removes itself in the Figma API the
      // moment the last child leaves — FRAME/other containers do not, so
      // only remove explicitly if it's still around. Either way, nested
      // "a group inside a group with nothing else" cascading auto-removal
      // isn't specially handled here.
      if (!node.removed) node.remove();
    } else {
      // Leaf node (RECTANGLE/TEXT/VECTOR/…): we can't turn the node's own
      // type into a component, so wrap a clone of it inside the new
      // component instead, then discard the original.
      const clone = node.clone();
      clone.x = 0;
      clone.y = 0;
      component.appendChild(clone);
      parent.insertChild(indexInParent >= 0 ? indexInParent : parent.children.length, component);
      node.remove();
    }

    return true;
  });
};

// ---------------------------------------------------------------------------
// applyAutoLayout
// ---------------------------------------------------------------------------
const applyAutoLayout: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as ApplyAutoLayoutActionParams;

  return forEachNode(nodes, ctx, async (node) => {
    if (!('layoutMode' in node)) throw new Error(`${node.type} does not support auto layout`);
    const target = node as SceneNode & {
      layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
      itemSpacing: number;
      paddingLeft: number;
      paddingRight: number;
      paddingTop: number;
      paddingBottom: number;
    };
    target.layoutMode = params.direction;
    target.itemSpacing = params.itemSpacing;
    target.paddingLeft = params.padding;
    target.paddingRight = params.padding;
    target.paddingTop = params.padding;
    target.paddingBottom = params.padding;
    return true;
  });
};

// ---------------------------------------------------------------------------
// updateVariable — whole action wrapped, never throws past this boundary
// ---------------------------------------------------------------------------
const updateVariable: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as UpdateVariableActionParams;
  try {
    if (!figma.variables || typeof figma.variables.getVariableByIdAsync !== 'function') {
      return { affected: 0, warnings: ['The Variables API is not available on this Figma editor/plan.'] };
    }
    const variable = await figma.variables.getVariableByIdAsync(params.variableId);
    if (!variable) {
      return { affected: 0, warnings: [`No variable found for id "${params.variableId}".`] };
    }

    return await forEachNode(nodes, ctx, async (node) => {
      const target = node as SceneNode & { setBoundVariable?: (field: string, v: Variable | null) => void };
      if (typeof target.setBoundVariable !== 'function') {
        throw new Error(`${node.type} does not support bound variables`);
      }
      target.setBoundVariable(params.field, variable);
      return true;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { affected: 0, warnings: [`updateVariable failed: ${message}`] };
  }
};

// ---------------------------------------------------------------------------
// export — lightweight convenience for macros only. The full batch export
// workflow (naming presets, multi-format, folder structure) is the separate
// Export Manager module built elsewhere; this is intentionally minimal.
// Bytes can't travel back through this function's {affected,warnings}
// return shape (fixed by the registry contract), so each exported node's
// bytes are pushed to the UI as a postEvent the AutomatorPage listens for.
// ---------------------------------------------------------------------------
const exportAction: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as ExportActionParams;

  return forEachNode(nodes, ctx, async (node) => {
    if (!('exportAsync' in node)) throw new Error(`${node.type} cannot be exported`);
    const exportable = node as SceneNode & ExportMixin;
    const settings = {
      format: params.format ?? 'PNG',
      constraint: { type: 'SCALE', value: params.scale ?? 1 },
    } as unknown as ExportSettings;
    const bytes = await exportable.exportAsync(settings);
    postEvent('automator', 'exportResult', {
      requestId: ctx.requestId,
      nodeId: node.id,
      nodeName: node.name,
      format: params.format ?? 'PNG',
      bytes: Array.from(bytes),
    });
    return true;
  });
};

// ---------------------------------------------------------------------------
// duplicate
// ---------------------------------------------------------------------------
const duplicate: ActionFn = async (nodes, rawParams, ctx) => {
  const params = rawParams as DuplicateActionParams;
  const offsetX = params.offsetX ?? 16;
  const offsetY = params.offsetY ?? 16;
  const clones: SceneNode[] = [];
  const warnings: string[] = [];
  let affected = 0;

  // node.clone() is synchronous, so the plain (non-async) chunk helper is
  // the right fit here.
  await processInChunks(
    nodes,
    (node) => {
      try {
        const clone = node.clone();
        if (node.parent) {
          const index = node.parent.children.indexOf(node);
          node.parent.insertChild(index + 1, clone);
        }
        if ('x' in clone && 'y' in clone) {
          (clone as Positioned).x += offsetX;
          (clone as Positioned).y += offsetY;
        }
        clones.push(clone);
        affected += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`${node.id}: ${message}`);
      }
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total }) }
  );

  if (clones.length > 0) figma.currentPage.selection = clones;
  return { affected, warnings };
};

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------
const deleteAction: ActionFn = async (nodes, rawParams, ctx) => {
  const warnings: string[] = [];
  let affected = 0;

  await processInChunks(
    nodes,
    (node) => {
      if (node.removed) {
        warnings.push(`${node.id}: node no longer exists`);
        return;
      }
      try {
        node.remove();
        affected += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`${node.id}: ${message}`);
      }
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total }) }
  );

  return { affected, warnings };
};

// ---------------------------------------------------------------------------
// group — whole-set operation (figma.group requires one call over the set),
// so this isn't run per-node like the others.
// ---------------------------------------------------------------------------
const group: ActionFn = async (nodes) => {
  if (nodes.length === 0) return { affected: 0, warnings: ['No nodes to group.'] };
  try {
    const validNodes = nodes.filter((n) => !n.removed && n.parent);
    if (validNodes.length === 0) {
      return { affected: 0, warnings: ['No valid nodes to group (all already removed or parentless).'] };
    }
    const parent = validNodes[0]!.parent!;
    const grouped = figma.group(validNodes, parent);
    figma.currentPage.selection = [grouped];
    const skipped = nodes.length - validNodes.length;
    return {
      affected: validNodes.length,
      warnings: skipped > 0 ? [`${skipped} node(s) were skipped (already removed or parentless).`] : [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { affected: 0, warnings: [`group failed: ${message}`] };
  }
};

// ---------------------------------------------------------------------------
// ungroup — best-effort approximation of Figma's native "Ungroup" for the
// common case (group has no rotation). See inline note.
// ---------------------------------------------------------------------------
const ungroup: ActionFn = async (nodes, _rawParams, ctx) => {
  return forEachNode(nodes, ctx, async (node) => {
    if (node.type !== 'GROUP') throw new Error(`${node.type} is not a group`);
    const groupNode = node;
    const parent = groupNode.parent;
    if (!parent) throw new Error('Group has no parent');

    const groupIndex = parent.children.indexOf(groupNode);
    const offsetX = groupNode.x;
    const offsetY = groupNode.y;

    // Figma's `x`/`y` on a child of a GROUP are relative to that group, not
    // to the page/frame the group itself lives in — so reparenting a child
    // straight into the group's parent would silently shift it on canvas
    // unless we translate by the group's own x/y first. NOTE: this is only
    // correct when the group has rotation 0. A rotated group's native
    // "Ungroup" also un-rotates each child relative to the new parent; we
    // deliberately don't attempt that transform here (best-effort, not a
    // general affine solve).
    let insertAt = groupIndex;
    for (const child of [...groupNode.children]) {
      if ('x' in child && 'y' in child) {
        const relX = (child as Positioned).x;
        const relY = (child as Positioned).y;
        parent.insertChild(insertAt, child);
        (child as Positioned).x = relX + offsetX;
        (child as Positioned).y = relY + offsetY;
      } else {
        parent.insertChild(insertAt, child);
      }
      insertAt += 1;
    }

    // The GROUP auto-removes itself the moment its last child leaves — this
    // guard covers the (unlikely) case that didn't happen.
    if (!groupNode.removed) groupNode.remove();
    return true;
  });
};

export const actionRegistry: Record<ActionType, ActionFn> = {
  rename,
  resize,
  move,
  align,
  distribute,
  rotate,
  scale,
  roundCorners,
  replaceColor,
  replaceFont,
  replaceImage,
  swapComponent,
  createComponent,
  applyAutoLayout,
  updateVariable,
  export: exportAction,
  duplicate,
  delete: deleteAction,
  group,
  ungroup,
};
