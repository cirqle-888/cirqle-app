/**
 * Core performance primitive: every module that walks the document MUST use
 * this instead of a plain `for`/`forEach`, or a 10,000+ layer file will
 * freeze Figma's UI thread for the duration of the scan. Figma's plugin
 * sandbox has no requestIdleCallback/Worker, so "async" here means yielding
 * to the event loop with setTimeout(0) every N items, which lets Figma
 * repaint and the UI stay responsive (and lets a "cancel" flag be honoured
 * between chunks).
 */

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface ChunkOptions {
  chunkSize?: number;
  signal?: { cancelled: boolean };
  onProgress?: (done: number, total: number) => void;
}

/** Iterate `items`, calling `fn` for each, yielding to the event loop every
 * `chunkSize` items. Returns the collected non-undefined results of `fn`. */
export async function processInChunks<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => R | undefined | void,
  options: ChunkOptions = {}
): Promise<R[]> {
  const { chunkSize = 250, signal, onProgress } = options;
  const results: R[] = [];
  const total = items.length;

  for (let i = 0; i < total; i += 1) {
    if (signal?.cancelled) break;

    const result = fn(items[i] as T, i);
    if (result !== undefined) results.push(result as R);

    if ((i + 1) % chunkSize === 0) {
      onProgress?.(i + 1, total);
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
  }

  onProgress?.(total, total);
  return results;
}

/** Same idea but for an async worker function (e.g. one that awaits
 * figma.getImageByHash / exportAsync per item). */
export async function processInChunksAsync<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R | undefined | void>,
  options: ChunkOptions = {}
): Promise<R[]> {
  const { chunkSize = 25, signal, onProgress } = options;
  const results: R[] = [];
  const total = items.length;

  for (let i = 0; i < total; i += 1) {
    if (signal?.cancelled) break;

    // eslint-disable-next-line no-await-in-loop
    const result = await fn(items[i] as T, i);
    if (result !== undefined) results.push(result as R);

    if ((i + 1) % chunkSize === 0) {
      onProgress?.(i + 1, total);
      // eslint-disable-next-line no-await-in-loop
      await yieldToEventLoop();
    }
  }

  onProgress?.(total, total);
  return results;
}

export function createCancelSignal() {
  const signal = { cancelled: false };
  return { signal, cancel: () => { signal.cancelled = true; } };
}
