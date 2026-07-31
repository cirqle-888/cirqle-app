import type { HandlerContext } from '../../bridge';
import type { RunScope } from '@shared/types';
import { runDesignQAScan, type DesignQAResult } from './qaEngine';

/** Design QA is read-only: no mutation, so no history recording. The last
 * scan result is kept in this module-level variable purely so
 * 'exportJson' can hand back the same payload the UI already has — it's
 * regenerated on every 'scan', so there's nothing to persist across
 * plugin reloads. */
let lastResult: DesignQAResult | null = null;

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'scan': {
      const requested = (payload as { scope?: RunScope['scope'] } | undefined)?.scope;
      const scope: RunScope['scope'] = requested ?? 'selection';
      const result = await runDesignQAScan(scope, ctx);
      lastResult = result;
      return result;
    }
    case 'exportJson': {
      if (!lastResult) throw new Error('Run a Design QA scan before exporting a report.');
      return JSON.stringify(lastResult, null, 2);
    }
    default:
      throw new Error(`designQA: unknown action "${action}"`);
  }
}
