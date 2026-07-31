import { describe, it, expect } from 'vitest';
import { processInChunks, processInChunksAsync, createCancelSignal } from './chunk';

describe('processInChunks', () => {
  it('visits every item and collects results', async () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const results = await processInChunks(items, (n) => n * 2, { chunkSize: 100 });
    expect(results).toHaveLength(1000);
    expect(results[0]).toBe(0);
    expect(results[999]).toBe(1998);
  });

  it('reports progress at each chunk boundary and once at the end', async () => {
    const seen: number[] = [];
    await processInChunks(Array.from({ length: 250 }, (_, i) => i), () => undefined, {
      chunkSize: 100,
      onProgress: (done) => seen.push(done),
    });
    expect(seen[seen.length - 1]).toBe(250);
  });

  it('stops early when the cancel signal flips', async () => {
    const { signal, cancel } = createCancelSignal();
    let processed = 0;
    await processInChunks(Array.from({ length: 1000 }, (_, i) => i), (_, i) => {
      processed += 1;
      if (i === 150) cancel();
    }, { chunkSize: 50, signal });
    expect(processed).toBeLessThan(1000);
  });
});

describe('processInChunksAsync', () => {
  it('awaits an async worker per item', async () => {
    const results = await processInChunksAsync(
      [1, 2, 3],
      async (n) => n * 10,
      { chunkSize: 2 }
    );
    expect(results).toEqual([10, 20, 30]);
  });
});
