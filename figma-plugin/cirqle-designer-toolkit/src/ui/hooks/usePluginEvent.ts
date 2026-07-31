import { useEffect } from 'react';
import type { ModuleId } from '@shared/types';
import { onPluginEvent } from '@ui/lib/bridge';

export function usePluginEvent<TPayload = unknown>(
  module: ModuleId,
  event: string,
  listener: (payload: TPayload) => void
) {
  useEffect(() => onPluginEvent<TPayload>(module, event, listener), [module, event, listener]);
}
