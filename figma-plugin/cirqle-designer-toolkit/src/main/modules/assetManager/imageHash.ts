/**
 * Helpers for walking a node's fills/strokes for IMAGE paints, plus a small
 * lazy, in-memory cache of image byte metadata keyed by Figma's image hash
 * (hashes are already content-addressed, so caching by hash naturally
 * de-dupes repeat lookups of the same underlying image across many nodes).
 *
 * On width/height: `getBytesAsync()` only returns the raw encoded bytes —
 * Figma doesn't expose decoded pixel dimensions on the main thread, and
 * decoding an arbitrary image format needs a <canvas>/Image element, which
 * only exists in the UI (browser) thread. Getting exact width/height would
 * mean a UI round trip per distinct image, which is a lot of latency for a
 * scan that's meant to be a quick "at a glance" pass. So for this module we
 * only report byte length here; width/height are "unavailable without a UI
 * round-trip" and are simply not part of the scan result.
 */

export type ImagePaintSource = 'fills' | 'strokes';

export interface ImagePaintRef {
  property: ImagePaintSource;
  paintIndex: number;
  imageHash: string;
}

/** Cast-based access rather than naming exact Figma mixin interface names
 * (e.g. MinimalFillsMixin) — this keeps the module resilient to small
 * typings differences across @figma/plugin-typings versions, since `Paint`
 * itself is a very stable, universally-used ambient type. */
function readPaintArrays(node: SceneNode): { fills?: ReadonlyArray<Paint>; strokes?: ReadonlyArray<Paint> } {
  const loose = node as unknown as { fills?: unknown; strokes?: unknown };
  return {
    fills: Array.isArray(loose.fills) ? (loose.fills as ReadonlyArray<Paint>) : undefined,
    strokes: Array.isArray(loose.strokes) ? (loose.strokes as ReadonlyArray<Paint>) : undefined,
  };
}

/** Yields every IMAGE paint on a node's fills and (if present) strokes. */
export function getImagePaints(node: SceneNode): ImagePaintRef[] {
  const refs: ImagePaintRef[] = [];
  const { fills, strokes } = readPaintArrays(node);

  fills?.forEach((paint, index) => {
    if (paint.type === 'IMAGE' && paint.imageHash) {
      refs.push({ property: 'fills', paintIndex: index, imageHash: paint.imageHash });
    }
  });

  strokes?.forEach((paint, index) => {
    if (paint.type === 'IMAGE' && paint.imageHash) {
      refs.push({ property: 'strokes', paintIndex: index, imageHash: paint.imageHash });
    }
  });

  return refs;
}

export interface ImageMeta {
  bytesLength: number;
}

const metaCache = new Map<string, ImageMeta>();

/** Lazily fetches + caches byte-length metadata for a given image hash.
 * Safe to call repeatedly for the same hash — only fetches once per hash,
 * regardless of how many nodes/paints reference it. */
export async function getImageMeta(hash: string): Promise<ImageMeta | null> {
  const cached = metaCache.get(hash);
  if (cached) return cached;

  const image = figma.getImageByHash(hash);
  if (!image) return null;

  try {
    const bytes = await image.getBytesAsync();
    const meta: ImageMeta = { bytesLength: bytes.length };
    metaCache.set(hash, meta);
    return meta;
  } catch {
    return null;
  }
}

export function clearImageMetaCache(): void {
  metaCache.clear();
}
