import type { HandlerContext } from '../../bridge';
import { actionRegistry } from './actions/actionRegistry';
import type { Macro } from './actions/actionTypes';

export interface MacroStepResult {
  actionType: string;
  affected: number;
  warnings: string[];
}

export interface MacroRunResult {
  affected: number;
  warnings: string[];
  stepResults: MacroStepResult[];
  stoppedEarly: boolean;
}

/**
 * Runs every step of a macro over the SAME resolved node list, in the order
 * the macro defines them.
 *
 * DESIGN CHOICE — one scope snapshot, not a per-step re-resolve: the caller
 * (index.ts) resolves `nodes` once from the chosen RunScope before calling
 * this, and every step operates on that same array. The alternative —
 * re-resolving the scope fresh before each step — would better handle a
 * step that adds nodes a *later* step should also see (e.g. `duplicate`
 * then `resize` the clones too), but it also means an earlier
 * `delete`/`ungroup` step silently redefines what "the scope" even means
 * for every step after it, which is harder to predict from the macro
 * builder UI and harder to show one coherent combined progress bar for. We
 * take the simpler, more predictable semantics: steps that touch a node
 * the previous step removed just fail that one node via the per-node
 * try/catch in actionRegistry.ts's `forEachNode`, surfacing as a warning
 * rather than a crash.
 */
export async function runMacro(
  macro: Macro,
  nodes: SceneNode[],
  ctx: HandlerContext,
  stopOnError: boolean
): Promise<MacroRunResult> {
  const stepResults: MacroStepResult[] = [];
  const allWarnings: string[] = [];
  let totalAffected = 0;
  let stoppedEarly = false;
  const totalSteps = Math.max(1, macro.steps.length);
  // Fixed-resolution blended progress: step i's own done/total ratio is
  // scaled into that step's own slice of `totalSteps` (a half-open interval
  // starting at i, up to but not including i+1), then reported out of a
  // constant PROGRESS_RESOLUTION so the UI sees one continuous bar across
  // the whole macro instead of it resetting to 0% at every step boundary.
  const PROGRESS_RESOLUTION = 1000;

  for (let i = 0; i < macro.steps.length; i += 1) {
    if (ctx.signal.cancelled) break;
    const step = macro.steps[i]!;
    const fn = actionRegistry[step.actionType];

    if (!fn) {
      const warning = `Unknown action type "${step.actionType}"`;
      stepResults.push({ actionType: step.actionType, affected: 0, warnings: [warning] });
      allWarnings.push(`Step ${i + 1} (${step.actionType}): ${warning}`);
      if (stopOnError) {
        stoppedEarly = true;
        break;
      }
      continue;
    }

    const stepCtx: HandlerContext = {
      ...ctx,
      reportProgress: (progress) => {
        const stepFraction = progress.total > 0 ? progress.done / progress.total : 1;
        const blended = (i + stepFraction) / totalSteps;
        ctx.reportProgress({
          done: Math.round(blended * PROGRESS_RESOLUTION),
          total: PROGRESS_RESOLUTION,
          label: `Step ${i + 1}/${macro.steps.length}: ${step.actionType}`,
        });
      },
    };

    // eslint-disable-next-line no-await-in-loop -- steps are intentionally sequential
    const result = await fn(nodes, step.params, stepCtx);
    stepResults.push({ actionType: step.actionType, affected: result.affected, warnings: result.warnings });
    totalAffected += result.affected;
    allWarnings.push(...result.warnings.map((w) => `Step ${i + 1} (${step.actionType}): ${w}`));

    // "Failed for every node" proxy: forEachNode-based actions push exactly
    // one warning per failing node, so a warning count >= the node count
    // means nothing in this step actually succeeded. Whole-set actions
    // (group/align/distribute on an empty/invalid set) return a single
    // summary warning instead, which also correctly counts as "every node
    // failed" when there were 0 successes.
    const stepFullyFailed = nodes.length > 0 && result.affected === 0 && result.warnings.length > 0;
    if (stopOnError && stepFullyFailed) {
      stoppedEarly = true;
      break;
    }
  }

  ctx.reportProgress({ done: PROGRESS_RESOLUTION, total: PROGRESS_RESOLUTION, label: 'Done' });

  return { affected: totalAffected, warnings: allWarnings, stepResults, stoppedEarly };
}
