/** Lightweight, dependency-free id generator usable on both the main thread
 * (no `crypto.randomUUID` guarantee inside Figma's sandbox on older desktop
 * builds) and the UI thread. Not cryptographically secure — doesn't need to
 * be, these ids only ever need to be unique within one plugin session. */
let seq = 0;

export function generateId(prefix = 'id'): string {
  seq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${seq}_${rand}`;
}
