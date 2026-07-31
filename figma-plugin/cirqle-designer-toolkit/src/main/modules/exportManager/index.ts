import type { HandlerContext } from '../../bridge';
import type { RunScope } from '@shared/types';
import { resolveScopeRoots } from '../../utils/traversal';
import { exportBatch, type RequestableExportFormat } from './exportEngine';

export async function handle(action: string, payload: unknown, ctx: HandlerContext): Promise<unknown> {
  switch (action) {
    case 'exportBatch': {
      // `quality` may be present in the payload (the UI always sends it)
      // but is intentionally unused on this thread: Figma's native
      // exportAsync has no adjustable quality knob for PNG/JPG, and WebP
      // quality is applied client-side by '@ui/lib/image/webpEncode' after
      // these PNG-tagged bytes come back across the bridge.
      const { scope, format, scales, namingPreset } = payload as {
        scope: RunScope['scope'];
        format: RequestableExportFormat;
        scales: number[];
        namingPreset: string;
      };

      const nodes = resolveScopeRoots(scope);
      const safeScales = scales.length > 0 ? scales : [1];
      const preset = namingPreset.trim() || '{name}@{scale}x.{format}';

      // Export is read-only from the document's point of view (no history
      // entry recorded — nothing in the file is mutated).
      return exportBatch(nodes, format, safeScales, preset, ctx);
    }

    default:
      throw new Error(`exportManager: unknown action "${action}"`);
  }
}
