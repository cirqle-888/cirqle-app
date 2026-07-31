import type { ModuleId, ProgressState } from '@shared/types';
import { PLUGIN_SOURCE, isPluginMessage, type UIRequest } from '@shared/messages';
import { logger } from './utils/logger';

export interface HandlerContext {
  requestId: string;
  module: ModuleId;
  reportProgress: (progress: ProgressState) => void;
  signal: { cancelled: boolean };
}

export type ModuleHandler = (action: string, payload: unknown, ctx: HandlerContext) => Promise<unknown>;

const registry = new Map<ModuleId, ModuleHandler>();
const activeSignals = new Map<string, { cancelled: boolean }>();

export function registerModule(id: ModuleId, handler: ModuleHandler): void {
  registry.set(id, handler);
}

function post(message: Record<string, unknown>) {
  figma.ui.postMessage({ source: PLUGIN_SOURCE, ...message });
}

export function postResult(id: string, module: ModuleId, payload: unknown) {
  post({ kind: 'result', id, module, payload });
}

export function postError(id: string, module: ModuleId, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(`${module}.${id} failed: ${message}`, stack);
  post({ kind: 'error', id, module, message, stack });
}

export function postProgress(id: string, module: ModuleId, progress: ProgressState) {
  post({ kind: 'progress', id, module, progress });
}

export function postEvent(module: ModuleId, event: string, payload?: unknown) {
  post({ kind: 'event', module, event, payload });
}

/** Wires figma.ui.onmessage to dispatch requests into the registry. Also
 * handles the one cross-cutting request every module gets for free:
 * `{ action: 'cancel' }` flips the cancel signal for a given request id. */
export function startDispatcher(): void {
  figma.ui.onmessage = async (raw: unknown) => {
    if (!isPluginMessage(raw) || raw.kind !== 'request') return;
    const req = raw as UIRequest;

    if (req.action === 'cancel') {
      activeSignals.get(req.id)?.cancelled === false &&
        (activeSignals.get(req.id)!.cancelled = true);
      return;
    }

    const handler = registry.get(req.module);
    if (!handler) {
      postError(req.id, req.module, new Error(`No handler registered for module "${req.module}"`));
      return;
    }

    const signal = { cancelled: false };
    activeSignals.set(req.id, signal);

    const ctx: HandlerContext = {
      requestId: req.id,
      module: req.module,
      reportProgress: (progress) => postProgress(req.id, req.module, progress),
      signal,
    };

    try {
      const result = await handler(req.action, req.payload, ctx);
      postResult(req.id, req.module, result);
    } catch (err) {
      postError(req.id, req.module, err);
    } finally {
      activeSignals.delete(req.id);
    }
  };
}
