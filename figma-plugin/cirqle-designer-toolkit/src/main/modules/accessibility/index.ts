/**
 * Accessibility Checker module. Read-only analysis (`scan`) plus one
 * document-mutating action (`applyFix`) that recolors either the flagged
 * text node or its resolved background node to the scan's suggested hex,
 * then records it in the cross-module history (see modules/system).
 */
import type { HandlerContext } from '../../bridge';
import { STORAGE_KEYS } from '@shared/constants';
import { DEFAULT_SETTINGS, type ToolkitSettings } from '@shared/types';
import { generateId } from '@shared/id';
import { loadJSON } from '../../utils/storage';
import { getNodeById } from '../../utils/traversal';
import { recordHistory } from '../system';
import { runA11yScan, findAncestorBackgroundNode, type A11yScanScope } from './a11yScan';

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'scan': {
      const { scope } = (payload as { scope?: string } | undefined) ?? {};
      const resolvedScope: A11yScanScope = scope === 'page' ? 'page' : 'selection';
      return runA11yScan({ scope: resolvedScope, ctx });
    }
    case 'applyFix': {
      const { nodeId, field, hex } = (payload ?? {}) as { nodeId?: string; field?: 'text' | 'background'; hex?: string };
      if (!nodeId || !field || !hex) {
        throw new Error('accessibility.applyFix requires { nodeId, field, hex }');
      }
      return applyFix(nodeId, field, hex);
    }
    default:
      throw new Error(`accessibility: unknown action "${action}"`);
  }
}

async function applyFix(nodeId: string, field: 'text' | 'background', hex: string): Promise<{
  ok: boolean;
  nodeId: string;
  field: 'text' | 'background';
  hex: string;
  durationMs: number;
}> {
  const start = Date.now();
  const source = getNodeById(nodeId);
  if (!source) throw new Error(`Node ${nodeId} no longer exists in the document.`);

  let target: SceneNode = source;
  if (field === 'background') {
    const ancestor = findAncestorBackgroundNode(source);
    if (!ancestor) {
      throw new Error(
        `"${source.name}"'s background is an assumed white canvas (no opaque solid-fill ancestor was found) — there is no node to recolor. Adjust the text colour instead.`
      );
    }
    target = ancestor;
  }

  if (!('fills' in target)) {
    throw new Error(`"${target.name}" has no fills property to update.`);
  }
  const fillsMixin = target as unknown as { fills: Paint[] | symbol };
  const fills = fillsMixin.fills;
  if (fills === figma.mixed || !Array.isArray(fills)) {
    throw new Error(`"${target.name}" has mixed or unreadable fills — cannot auto-fix.`);
  }

  let paintIndex = -1;
  for (let i = fills.length - 1; i >= 0; i -= 1) {
    const paint = fills[i]!;
    if (paint.type === 'SOLID' && paint.visible !== false) {
      paintIndex = i;
      break;
    }
  }
  if (paintIndex === -1) {
    throw new Error(`No visible solid paint was found on "${target.name}" to update.`);
  }

  const existing = fills[paintIndex]! as SolidPaint;
  const nextFills = fills.slice();
  nextFills[paintIndex] = { ...existing, color: hexToRgb01(hex) };
  (target as unknown as { fills: Paint[] }).fills = nextFills;

  const settings = await loadJSON<ToolkitSettings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  await recordHistory(
    {
      id: generateId('hist'),
      module: 'accessibility',
      action: 'applyFix',
      summary: `Adjusted ${field} colour on "${target.name}" to ${hex} to fix a contrast issue`,
      timestamp: Date.now(),
      affectedNodeIds: [target.id],
      // Programmatic fill edits made via the Plugin API don't register a
      // native Cmd/Ctrl+Z step the way manual edits do, so this can't
      // honestly be marked undoable from the toolkit's own history UI.
      undoable: false,
    },
    settings.keepHistoryCount
  );

  return { ok: true, nodeId: target.id, field, hex, durationMs: Date.now() - start };
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const value = parseInt(clean, 16);
  return {
    r: ((value >> 16) & 255) / 255,
    g: ((value >> 8) & 255) / 255,
    b: (value & 255) / 255,
  };
}
