/**
 * UI-thread-only image compression helper. Image decode/encode needs
 * Canvas, which only exists in this (browser iframe) runtime — never in
 * src/main/**, which runs in Figma's sandbox with no DOM.
 *
 * Round trip: raw bytes -> Blob -> createImageBitmap -> draw to an
 * offscreen <canvas> (optionally downscaled) -> canvas.toBlob -> Blob ->
 * Uint8Array. The caller sends the result back to the main thread, which
 * calls figma.createImage(bytes) and reassigns the fill.
 */

export interface CompressImageOptions {
  /** Longest-edge cap in px; the image is downscaled (aspect preserved) if
   * either dimension exceeds this. Left as-is if already smaller. */
  maxDimension?: number;
  /** 0..1, only meaningful for lossy formats (jpeg/webp). */
  quality?: number;
  mimeType?: 'image/jpeg' | 'image/webp';
}

export async function compressImage(bytes: Uint8Array, opts: CompressImageOptions = {}): Promise<Uint8Array> {
  const { maxDimension = 2048, quality = 0.8, mimeType = 'image/jpeg' } = opts;

  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);

  let { width, height } = bitmap;
  if (width > maxDimension || height > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot compress image in this environment.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const outBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null while compressing the image.'))),
      mimeType,
      quality
    );
  });

  return new Uint8Array(await outBlob.arrayBuffer());
}
