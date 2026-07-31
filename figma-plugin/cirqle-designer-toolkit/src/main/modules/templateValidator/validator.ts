/**
 * Pure(-ish) matching/validation logic for Template Validator. Deliberately
 * free of any `figma.*` calls so it can run against either live SceneNodes
 * (main-thread validate/autoFix flows) or plain NodeRef-shaped objects
 * (tests, or any future UI-side preview) — both only need `.name`.
 */
import type { Issue, Severity, NodeRef } from '@shared/types';
import { generateId } from '@shared/id';
import type { TemplateRule } from './templateValidatorTypes';

/**
 * Does `layerName` satisfy the `#token` contract for `token`?
 *
 * Mirrors real-world naming conventions where a layer is named exactly
 * `#token` or `#token` followed by a disambiguating suffix such as
 * `#product-3`, `#product_3` or `#product2` (multiple instances of the same
 * data-fill target inside one template). Case-insensitive. A following
 * separator/digit is required (or nothing at all) so `#product` does not
 * accidentally match a differently-named token like `#products`.
 */
export function matchesToken(layerName: string, token: string): boolean {
  const name = layerName.trim().toLowerCase();
  const target = `#${token.trim().toLowerCase()}`;
  if (!name.startsWith(target)) return false;
  const rest = name.slice(target.length);
  if (rest.length === 0) return true;
  return /^[-_ ]?\d*$/.test(rest) && rest !== '-' && rest !== '_';
}

/** Minimal shape both SceneNode and NodeRef satisfy — only `.name` is used. */
export type NamedNode = { name: string };

/**
 * Walks a flat list of already-collected layer names (see
 * `src/main/modules/templateValidator/index.ts` for how the caller gathers
 * every descendant of the selected root(s)) and returns one Issue per
 * missing required-layers-contract token. Present tokens produce no issue.
 */
export function validateTree(nodes: NamedNode[] | NodeRef[] | SceneNode[], rule: TemplateRule): Issue[] {
  const names = (nodes as NamedNode[]).map((n) => n.name);
  const issues: Issue[] = [];

  for (const layer of rule.requiredLayers) {
    const present = names.some((name) => matchesToken(name, layer.name));
    if (present) continue;

    const severity: Severity = layer.required ? 'error' : 'warning';
    const suggestion = `Add a text or image layer named "#${layer.name}"`;
    issues.push({
      id: generateId('issue'),
      ruleId: `templateValidator:${rule.id}:${layer.name}`,
      severity,
      title: `Missing "#${layer.name}" layer`,
      description: layer.hint ? `${suggestion} — ${layer.hint}` : `${suggestion}.`,
      meta: { token: layer.name, required: layer.required },
      autoFixable: true,
    });
  }

  return issues;
}

export interface ValidationSummary {
  issues: Issue[];
  presentCount: number;
  missingCount: number;
}

/** Convenience wrapper matching the `'validate'` action's return shape. */
export function summarizeValidation(nodes: NamedNode[] | NodeRef[] | SceneNode[], rule: TemplateRule): ValidationSummary {
  const issues = validateTree(nodes, rule);
  const missingCount = issues.length;
  const presentCount = Math.max(0, rule.requiredLayers.length - missingCount);
  return { issues, presentCount, missingCount };
}
