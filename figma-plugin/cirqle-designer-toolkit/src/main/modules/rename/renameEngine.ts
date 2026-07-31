/**
 * Pure rename engine — no `figma`/DOM/clock dependency, so it's trivially
 * unit-testable (e.g. with vitest) without a Figma sandbox mock. The one
 * thing that would normally be a hidden dependency (today's date) is instead
 * passed in via `RenameContext.date`, computed once by the caller
 * (main/modules/rename/index.ts) at the top of the batch.
 */
import type { NumberingConfig, RenameRule } from './renameTypes';

export interface RenameContext {
  /** Figma node type, e.g. "FRAME", passed through as-is for {type}. */
  type: string;
  /** Parent layer's name, or '' if the node has no parent (a page root). */
  parent: string;
  /** Current page name. */
  page: string;
  /** Pre-formatted YYYY-MM-DD string. */
  date: string;
  /** Total number of nodes in this rename batch — used to size {nn}'s
   * zero-padding to the widest index (e.g. a 12-item batch pads to "01"). */
  batchCount: number;
}

export type BuildNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string };

/** Escape a plain string for safe use inside `new RegExp(...)`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function paddedWidth(numbering: NumberingConfig, batchCount: number): number {
  const maxIndex = numbering.startNumber + Math.max(0, batchCount - 1);
  return String(Math.max(0, maxIndex)).length;
}

/** Resolve every RENAME_VARIABLES token in `text`. {n}/{nn}/{index} are only
 * resolved when `numbering.enabled` is true (see NumberingConfig doc) —
 * otherwise they're left as literal text so a disabled numbering toggle is
 * visibly a no-op in a preview rather than silently stripping braces. */
function resolveVariables(text: string, index: number, ctx: RenameContext, numbering: NumberingConfig): string {
  let out = text;

  if (numbering.enabled) {
    const num = numbering.startNumber + index;
    const unpadded = String(num);
    const padded = numbering.padding === 'auto' ? unpadded.padStart(paddedWidth(numbering, ctx.batchCount), '0') : unpadded;
    out = out.replace(/\{n\}/g, unpadded);
    out = out.replace(/\{nn\}/g, padded);
    out = out.replace(/\{index\}/g, unpadded);
  }

  out = out.replace(/\{type\}/g, ctx.type);
  out = out.replace(/\{parent\}/g, ctx.parent);
  out = out.replace(/\{page\}/g, ctx.page);
  out = out.replace(/\{date\}/g, ctx.date);

  return out;
}

/**
 * Builds the new name for a single node. Application order (all steps are
 * independently skippable via each sub-rule's `enabled` flag):
 *
 *   1. find & replace (plain substring or regex) runs against the raw old
 *      name, producing an intermediate `base` string. Regex replacement
 *      text may use capture-group refs ($1, $2, ...) — those are resolved
 *      natively by String.prototype.replace before smart variables are.
 *   2. `prefix.value` + base + `suffix.value` are concatenated.
 *   3. smart-variable tokens ({n} {nn} {type} {parent} {page} {date}
 *      {index}) are resolved across the *entire* assembled string, so a
 *      token can appear inside the prefix, the suffix, or inside a find &
 *      replace replacement string — wherever the user typed it.
 *
 * Never throws: an invalid regex (or any unexpected error) is caught and
 * reported as `{ ok: false, error }` for that one row so a bad rule can't
 * abort an entire batch.
 */
export function buildNewName(oldName: string, index: number, ctx: RenameContext, rule: RenameRule): BuildNameResult {
  try {
    let base = oldName;

    if (rule.findReplace.enabled && rule.findReplace.find !== '') {
      if (rule.findReplace.mode === 'regex') {
        let flags = rule.findReplace.flags || 'g';
        if (!flags.includes('g')) flags += 'g';
        let regex: RegExp;
        try {
          regex = new RegExp(rule.findReplace.find, flags);
        } catch (err) {
          return { ok: false, error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` };
        }
        base = base.replace(regex, rule.findReplace.replace);
      } else {
        const flags = rule.findReplace.caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(escapeRegExp(rule.findReplace.find), flags);
        base = base.replace(regex, rule.findReplace.replace);
      }
    }

    const prefixValue = rule.prefix.enabled ? rule.prefix.value : '';
    const suffixValue = rule.suffix.enabled ? rule.suffix.value : '';
    const assembled = `${prefixValue}${base}${suffixValue}`;

    const finalName = resolveVariables(assembled, index, ctx, rule.numbering);
    return { ok: true, name: finalName };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Convenience for the caller to format "today" once for the whole batch,
 * kept out of the pure functions above so they stay clock-free. */
export function formatDateYYYYMMDD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
