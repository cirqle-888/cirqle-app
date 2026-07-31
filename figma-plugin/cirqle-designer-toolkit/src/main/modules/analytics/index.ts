import type { HandlerContext } from '../../bridge';
import type { RunScope } from '@shared/types';
import { runAnalyticsScan } from './analyticsEngine';

/** Document Analytics is read-only: no mutation, so no history recording. */
export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'scan': {
      const requested = (payload as { scope?: RunScope['scope'] } | undefined)?.scope;
      const scope: RunScope['scope'] = requested === 'document' ? 'document' : 'page';
      return runAnalyticsScan(scope, ctx);
    }
    default:
      throw new Error(`analytics: unknown action "${action}"`);
  }
}
