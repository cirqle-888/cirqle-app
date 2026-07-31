/**
 * Typed request/response protocol between the UI (iframe, React) and the
 * main thread (Figma sandbox). Every module speaks this same envelope, which
 * is what lets modules be built independently: a UI page only needs to know
 * its own `action` names and payload shapes, never how postMessage works.
 *
 * Wire shape (all directions): a single object tagged with `source` so we
 * can ignore Figma-internal or unrelated postMessage traffic sharing the
 * same window.
 */
import type { ModuleId, ProgressState } from './types';

export const PLUGIN_SOURCE = 'cirqle-designer-toolkit' as const;

export interface UIRequest<TPayload = unknown> {
  source: typeof PLUGIN_SOURCE;
  kind: 'request';
  id: string;
  module: ModuleId;
  action: string;
  payload?: TPayload;
}

export interface MainResult<TPayload = unknown> {
  source: typeof PLUGIN_SOURCE;
  kind: 'result';
  id: string;
  module: ModuleId;
  payload: TPayload;
}

export interface MainErrorMsg {
  source: typeof PLUGIN_SOURCE;
  kind: 'error';
  id: string;
  module: ModuleId;
  message: string;
  stack?: string;
}

export interface MainProgressMsg {
  source: typeof PLUGIN_SOURCE;
  kind: 'progress';
  id: string;
  module: ModuleId;
  progress: ProgressState;
}

export interface MainEventMsg<TPayload = unknown> {
  source: typeof PLUGIN_SOURCE;
  kind: 'event';
  module: ModuleId;
  event: string;
  payload?: TPayload;
}

export type MainToUIMessage = MainResult | MainErrorMsg | MainProgressMsg | MainEventMsg;
export type PluginMessage = UIRequest | MainToUIMessage;

export function isPluginMessage(msg: unknown): msg is PluginMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { source?: unknown }).source === PLUGIN_SOURCE
  );
}

let counter = 0;
/** Correlation ids only need to be unique within one plugin session. */
export function nextRequestId(): string {
  counter += 1;
  return `req_${Date.now().toString(36)}_${counter}`;
}
