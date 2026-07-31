import { useCallback, useRef, useState } from 'react';
import type { ModuleId, ProgressState } from '@shared/types';
import { requestPlugin } from '@ui/lib/bridge';

export interface UsePluginMessageState {
  loading: boolean;
  progress: ProgressState | null;
  error: string | null;
}

/**
 * React hook wrapper around the request/response bridge. Every module page
 * uses this the same way:
 *
 *   const { run, loading, progress } = usePluginMessage('cleaner');
 *   const result = await run('scan', { mode: 'deep' });
 */
export function usePluginMessage(module: ModuleId) {
  const [state, setState] = useState<UsePluginMessageState>({ loading: false, progress: null, error: null });
  const cancelRef = useRef<(() => void) | null>(null);

  const run = useCallback(
    async <TResult = unknown>(action: string, payload?: unknown): Promise<TResult> => {
      setState({ loading: true, progress: null, error: null });
      const { promise, cancel } = requestPlugin<TResult>(module, action, payload, (progress) => {
        setState((s) => ({ ...s, progress }));
      });
      cancelRef.current = cancel;
      try {
        const result = await promise;
        setState({ loading: false, progress: null, error: null });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState({ loading: false, progress: null, error: message });
        throw err;
      }
    },
    [module]
  );

  const cancel = useCallback(() => cancelRef.current?.(), []);

  return { run, cancel, ...state };
}
