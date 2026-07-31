/**
 * UI-side (iframe) half of the request/response protocol. Figma wraps every
 * message the two threads exchange in a `pluginMessage` envelope — sending
 * uses `parent.postMessage({ pluginMessage }, '*')`, receiving reads
 * `event.data.pluginMessage`. This module hides that plumbing behind a
 * small typed request/subscribe API so pages never touch postMessage.
 */
import type { ModuleId, ProgressState } from '@shared/types';
import {
  PLUGIN_SOURCE,
  isPluginMessage,
  nextRequestId,
  type MainEventMsg,
  type MainToUIMessage,
  type UIRequest,
} from '@shared/messages';

type PendingEntry = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  onProgress?: (progress: ProgressState) => void;
};

const pending = new Map<string, PendingEntry>();
type EventListener = (payload: unknown) => void;
const eventBus = new Map<string, Set<EventListener>>();

function eventKey(module: ModuleId, event: string) {
  return `${module}::${event}`;
}

function send(request: UIRequest) {
  window.parent.postMessage({ pluginMessage: request }, '*');
}

window.addEventListener('message', (evt: MessageEvent) => {
  const msg = (evt.data as { pluginMessage?: unknown } | undefined)?.pluginMessage;
  if (!isPluginMessage(msg)) return;
  const m = msg as MainToUIMessage;

  if (m.kind === 'event') {
    const listeners = eventBus.get(eventKey(m.module, m.event));
    listeners?.forEach((fn) => fn(m.payload));
    return;
  }

  const entry = pending.get(m.id);
  if (!entry) return;

  if (m.kind === 'progress') {
    entry.onProgress?.(m.progress);
    return;
  }
  if (m.kind === 'result') {
    pending.delete(m.id);
    entry.resolve(m.payload);
    return;
  }
  if (m.kind === 'error') {
    pending.delete(m.id);
    entry.reject(new Error(m.message));
  }
});

export function requestPlugin<TResult = unknown>(
  module: ModuleId,
  action: string,
  payload?: unknown,
  onProgress?: (progress: ProgressState) => void
): { promise: Promise<TResult>; requestId: string; cancel: () => void } {
  const id = nextRequestId();
  const promise = new Promise<TResult>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
  });
  send({ source: PLUGIN_SOURCE, kind: 'request', id, module, action, payload });

  const cancel = () => {
    send({ source: PLUGIN_SOURCE, kind: 'request', id, module, action: 'cancel' });
  };

  return { promise, requestId: id, cancel };
}

export function onPluginEvent<TPayload = unknown>(
  module: ModuleId,
  event: string,
  listener: (payload: TPayload) => void
): () => void {
  const key = eventKey(module, event);
  if (!eventBus.has(key)) eventBus.set(key, new Set());
  eventBus.get(key)!.add(listener as EventListener);
  return () => eventBus.get(key)?.delete(listener as EventListener);
}

export type { MainEventMsg };
