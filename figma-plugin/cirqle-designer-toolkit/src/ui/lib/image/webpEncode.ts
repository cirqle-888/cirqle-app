/**
 * UI-thread-only WebP encoder, used by both Asset Manager (optional
 * compression target) and Export Manager (Figma's native export API has no
 * WebP format — PNG bytes come back from the main thread tagged
 * `requestedFormat: 'WEBP'`, and this is the step that turns them into a
 * real WebP file before download). Same Canvas round trip as
 * canvasResize.ts, specialised to a fixed WebP output with no resizing.
 *
 * Browser support note: canvas.toBlob(cb, 'image/webp', quality) depends on
 * the embedding browser's Canvas implementation supporting WebP encoding.
 * Figma's desktop app runs on Chromium, which supports it; if a future
 * runtime doesn't, canvas.toBlob will invoke the callback with `null` and
 * this rejects with a clear error rather than silently producing garbage.
 */

export async function pngBytesToWebp(bytes: Uint8Array, quality: number): Promise<Uint8Array> {
  const blob = new Blob([bytes]);
  const bitmap = await createImageBitmap(blob);

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot encode WebP in this environment.');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const outBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null — this browser may not support WebP encoding.'))),
      'image/webp',
      quality
    );
  });

  return new Uint8Array(await outBlob.arrayBuffer());
}
