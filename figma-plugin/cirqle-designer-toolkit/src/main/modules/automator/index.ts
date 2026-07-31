/** Automator module handler — reusable macros + one-off actions over a
 * resolved scope of SceneNodes. See actions/actionRegistry.ts for the
 * per-ActionType implementations and macroRunner.ts for how a macro's steps
 * get run in sequence. */
import type { HandlerContext } from '../../bridge';
import { collectNodes } from '../../utils/traversal';
import { recordHistory } from '../system';
import { generateId } from '@shared/id';
import type { OperationResult, RunScope } from '@shared/types';
import { actionRegistry } from './actions/actionRegistry';
import { runMacro, type MacroRunResult } from './macroRunner';
import * as macroStorage from './macroStorage';
import type { ActionType } from './actions/actionTypes';

const HISTORY_CAP = 200;
/** History entries only need enough node ids to be useful in a log, not a
 * full undo manifest — capped so one document-scope run doesn't bloat
 * clientStorage. Automator does not implement structured undo; Figma's own
 * Cmd/Ctrl+Z still works since every action performs ordinary node
 * mutations, nothing bypasses the document's native undo stack. */
const MAX_HISTORY_NODE_IDS = 200;

/**
 * SCOPE RESOLUTION CHOICE: Automator resolves EVERY descendant node under
 * the chosen scope (not just the scope's top-level layers) via
 * traversal.ts's collectNodes. This matches how most of Automator's actions
 * are meant to be used — bulk rename/recolor/round-corners/replace-font
 * reaching nested layers inside a selected frame — at the cost of
 * whole-set actions (align/distribute/group) potentially seeing a much
 * bigger, more granular node list than a user might expect when they pick
 * 'page' or 'document' scope. Users composing those specific actions should
 * generally reach for 'selection' scope with the exact top-level layers
 * selected.
 */
async function resolveNodes(scope: RunScope['scope'], ctx: HandlerContext): Promise<SceneNode[]> {
  return collectNodes(scope, () => true, {
    signal: ctx.signal,
    onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Resolving scope…' }),
  });
}

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'runAction':
      return runSingleAction(payload as { actionType: ActionType; params: unknown; scope: RunScope['scope'] }, ctx);
    case 'runMacro':
      return runMacroAction(payload as { macroId: string; scope: RunScope['scope']; stopOnError?: boolean }, ctx);
    case 'listMacros':
      return macroStorage.listMacros();
    case 'saveMacro':
      return macroStorage.saveMacro(payload as macroStorage.SaveMacroInput);
    case 'deleteMacro':
      return macroStorage.deleteMacro((payload as { id: string }).id);
    case 'duplicateMacro':
      return macroStorage.duplicateMacro((payload as { id: string }).id);
    case 'importMacro':
      return macroStorage.importMacro((payload as { macro: unknown }).macro);
    case 'exportMacro': {
      const { id } = payload as { id: string };
      const macro = await macroStorage.getMacro(id);
      if (!macro) throw new Error(`automator: no macro found for id "${id}"`);
      return macro;
    }
    default:
      throw new Error(`automator: unknown action "${action}"`);
  }
}

async function runSingleAction(
  payload: { actionType: ActionType; params: unknown; scope: RunScope['scope'] },
  ctx: HandlerContext
): Promise<OperationResult> {
  const started = Date.now();
  const nodes = await resolveNodes(payload.scope, ctx);
  const fn = actionRegistry[payload.actionType];
  if (!fn) throw new Error(`automator: unknown action type "${payload.actionType}"`);

  const result = await fn(nodes, payload.params, ctx);

  await recordHistory(
    {
      id: generateId('hist'),
      module: 'automator',
      action: `runAction:${payload.actionType}`,
      summary: `${payload.actionType} on ${result.affected} node(s)${result.warnings.length ? ` — ${result.warnings.length} warning(s)` : ''}`,
      timestamp: Date.now(),
      affectedNodeIds: nodes.slice(0, MAX_HISTORY_NODE_IDS).map((n) => n.id),
      undoable: false,
    },
    HISTORY_CAP
  );

  return {
    ok: true,
    warnings: result.warnings,
    durationMs: Date.now() - started,
    affectedCount: result.affected,
  };
}

async function runMacroAction(
  payload: { macroId: string; scope: RunScope['scope']; stopOnError?: boolean },
  ctx: HandlerContext
): Promise<OperationResult<{ stepResults: MacroRunResult['stepResults']; stoppedEarly: boolean }>> {
  const started = Date.now();
  const macro = await macroStorage.getMacro(payload.macroId);
  if (!macro) throw new Error(`automator: no macro found for id "${payload.macroId}"`);

  const nodes = await resolveNodes(payload.scope, ctx);
  const result = await runMacro(macro, nodes, ctx, payload.stopOnError ?? false);

  await recordHistory(
    {
      id: generateId('hist'),
      module: 'automator',
      action: `runMacro:${macro.name}`,
      summary: `Macro "${macro.name}" — ${result.stepResults.length} step(s), ${result.affected} affected node-op(s)${
        result.stoppedEarly ? ' (stopped early)' : ''
      }`,
      timestamp: Date.now(),
      affectedNodeIds: nodes.slice(0, MAX_HISTORY_NODE_IDS).map((n) => n.id),
      undoable: false,
    },
    HISTORY_CAP
  );

  return {
    ok: true,
    data: { stepResults: result.stepResults, stoppedEarly: result.stoppedEarly },
    warnings: result.warnings,
    durationMs: Date.now() - started,
    affectedCount: result.affected,
  };
}
