import type { HandlerContext } from '../../bridge';
import { STORAGE_KEYS } from '@shared/constants';
import { loadJSON, saveJSON } from '../../utils/storage';
import { collectNodes, getNodeById, toNodeRef } from '../../utils/traversal';
import { yieldToEventLoop } from '../../utils/chunk';
import { generateId } from '@shared/id';
import { DEFAULT_SETTINGS, type ToolkitSettings, type HistoryEntry } from '@shared/types';
import { recordHistory } from '../system';
import { SEED_TEMPLATE_RULES, type TemplateRule } from './templateValidatorTypes';
import { summarizeValidation } from './validator';
import { createPlaceholder } from './autoFix';

async function getRules(): Promise<TemplateRule[]> {
  const saved = await loadJSON<TemplateRule[]>(STORAGE_KEYS.templateRules, []);
  if (saved.length > 0) return saved;
  // First run: seed with the built-in presets so the rule picker isn't
  // empty, then persist so future edits land on top of a real saved copy
  // rather than the frozen module-level constant.
  const seeded: TemplateRule[] = JSON.parse(JSON.stringify(SEED_TEMPLATE_RULES)) as TemplateRule[];
  await saveJSON(STORAGE_KEYS.templateRules, seeded);
  return seeded;
}

function findRule(rules: TemplateRule[], ruleId: string): TemplateRule {
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`Template rule "${ruleId}" not found.`);
  return rule;
}

/** Walks a single node's own subtree (the node itself + every descendant),
 * chunked so a very deep/wide template root doesn't block the UI thread.
 * Unlike `traversal.collectNodes` (which always starts from the current
 * selection/page/document), autoFix needs to re-scan one specific root by
 * id, since that root may not still be the active selection by the time
 * the request round-trips. */
async function collectSubtree(root: SceneNode, ctx: HandlerContext, chunkSize = 250): Promise<SceneNode[]> {
  const collected: SceneNode[] = [root];
  const stack: SceneNode[] = [root];
  let visited = 0;

  while (stack.length > 0) {
    if (ctx.signal.cancelled) break;
    const node = stack.pop() as SceneNode;
    visited += 1;

    if ('children' in node) {
      const kids = (node as ChildrenMixin & SceneNode).children;
      for (const kid of kids) {
        collected.push(kid as SceneNode);
        stack.push(kid as SceneNode);
      }
    }

    if (visited % chunkSize === 0) {
      ctx.reportProgress({ done: visited, total: visited + stack.length, label: 'Scanning template…' });
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
  }

  ctx.reportProgress({ done: collected.length, total: collected.length });
  return collected;
}

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'listRules':
      return getRules();

    // Not one of the four actions the brief enumerates, but the UI needs
    // to know *which* selected node(s) are valid auto-fix targets (only
    // FRAME/COMPONENT roots) before it can send a nodeId to 'autoFix' —
    // this is a small read-only helper alongside 'validate', not a new
    // mutating capability.
    case 'getSelectionRoots': {
      return figma.currentPage.selection
        .filter((n): n is FrameNode | ComponentNode => n.type === 'FRAME' || n.type === 'COMPONENT')
        .map((n) => toNodeRef(n));
    }

    case 'saveRule': {
      const incoming = payload as Partial<TemplateRule> & { requiredLayers?: TemplateRule['requiredLayers'] };
      if (!incoming || typeof incoming.label !== 'string' || incoming.label.trim() === '') {
        throw new Error('A rule set needs a label.');
      }
      const rules = await getRules();
      const id = incoming.id && rules.some((r) => r.id === incoming.id) ? incoming.id : generateId('rule');
      const rule: TemplateRule = {
        id,
        label: incoming.label.trim(),
        requiredLayers: (incoming.requiredLayers ?? []).map((l) => ({
          name: l.name.trim().replace(/^#/, ''),
          required: Boolean(l.required),
          hint: l.hint?.trim() || undefined,
        })),
      };
      const next = [...rules.filter((r) => r.id !== id), rule].sort((a, b) => a.label.localeCompare(b.label));
      await saveJSON(STORAGE_KEYS.templateRules, next);
      return { rule, rules: next };
    }

    case 'deleteRule': {
      const { id } = payload as { id: string };
      const rules = await getRules();
      const next = rules.filter((r) => r.id !== id);
      await saveJSON(STORAGE_KEYS.templateRules, next);
      return { rules: next };
    }

    case 'validate': {
      const { ruleId } = payload as { scope?: 'selection'; ruleId: string };
      const rules = await getRules();
      const rule = findRule(rules, ruleId);

      if (figma.currentPage.selection.length === 0) {
        throw new Error('Select a template frame or component to validate first.');
      }

      // Template Validator only ever runs against the current selection —
      // an arbitrary page/document scope has no single "root" a #layer
      // contract could be checked against.
      const nodes = await collectNodes(
        'selection',
        () => true,
        {
          chunkSize: 250,
          signal: ctx.signal,
          onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Validating…' }),
        }
      );

      return summarizeValidation(nodes, rule);
    }

    case 'autoFix': {
      const { nodeId, ruleId } = payload as { nodeId: string; ruleId: string };
      const rules = await getRules();
      const rule = findRule(rules, ruleId);

      const root = getNodeById(nodeId);
      if (!root) throw new Error('The selected template root could not be found (it may have been deleted).');
      if (root.type !== 'FRAME' && root.type !== 'COMPONENT') {
        throw new Error('Auto-fix can only create placeholder layers inside a frame or component.');
      }
      const parent = root as FrameNode | ComponentNode;

      const before = await collectSubtree(parent, ctx);
      const missing = summarizeValidation(before, rule).issues.filter((i) => i.meta && (i.meta as { required?: boolean }).required);

      const createdIds: string[] = [];
      let created = 0;
      for (const issue of missing) {
        if (ctx.signal.cancelled) break;
        const token = (issue.meta as { token: string }).token;
        // eslint-disable-next-line no-await-in-loop
        const node = await createPlaceholder(parent, token);
        createdIds.push(node.id);
        created += 1;
        ctx.reportProgress({ done: created, total: missing.length, label: `Creating "#${token}"…` });
        if (created % 10 === 0) {
          // eslint-disable-next-line no-await-in-loop
          await yieldToEventLoop();
        }
      }

      if (created > 0) {
        const settings = await loadJSON<ToolkitSettings>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
        const entry: HistoryEntry = {
          id: generateId('hist'),
          module: 'templateValidator',
          action: 'autoFix',
          summary: `Created ${created} placeholder layer${created === 1 ? '' : 's'} in "${parent.name}" for rule "${rule.label}"`,
          timestamp: Date.now(),
          affectedNodeIds: createdIds,
          // We don't implement an in-plugin inverse for this — Figma's own
          // Cmd/Ctrl+Z undo stack covers it since these are ordinary node
          // creations, so this is marked non-undoable from *our* history UI.
          undoable: false,
        };
        await recordHistory(entry, settings.keepHistoryCount);
      }

      const after = await collectSubtree(parent, ctx);
      const result = summarizeValidation(after, rule);
      return { ...result, createdCount: created, createdNodeIds: createdIds };
    }

    default:
      throw new Error(`templateValidator: unknown action "${action}"`);
  }
}
