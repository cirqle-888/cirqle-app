/** Auto-fix side of Template Validator: creates a placeholder layer named
 * `#token` inside a template root so the required-layers contract is
 * satisfied. This is the only mutating action across Template Validator /
 * Analytics / Design QA — callers MUST record history after invoking it
 * (see `index.ts`). */

const IMAGE_LIKE_PATTERN = /image|photo|icon|logo/i;

/** Loads a safe default font before any new text node's `.characters` can
 * be set. Figma requires the font currently assigned to a TextNode to be
 * loaded before you touch its characters/style — `figma.createText()`
 * nodes default to a font that may not be loaded (or, rarely, not
 * installed at all on this Figma instance), so we try Inter Regular first
 * and fall back to whatever the first available font is. */
async function loadSafeDefaultFont(): Promise<FontName> {
  const preferred: FontName = { family: 'Inter', style: 'Regular' };
  try {
    await figma.loadFontAsync(preferred);
    return preferred;
  } catch {
    // Inter isn't installed/available in this Figma instance — fall back.
  }
  try {
    const available = await figma.listAvailableFontsAsync();
    const fallback = available[0]?.fontName;
    if (fallback) {
      await figma.loadFontAsync(fallback);
      return fallback;
    }
  } catch {
    // Nothing we can do — figma.createText() will keep its own default,
    // which the caller then attempts to set characters on (may no-op).
  }
  return preferred;
}

function computeChildrenBoundingBox(parent: FrameNode | ComponentNode): { minX: number; maxY: number } {
  const kids = parent.children;
  let minX = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const kid of kids) {
    if (!('x' in kid) || !('y' in kid) || !('height' in kid)) continue;
    const box = kid as SceneNode & { x: number; y: number; height: number };
    minX = Math.min(minX, box.x);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX)) minX = 0;
  if (!Number.isFinite(maxY)) maxY = 0;
  return { minX, maxY };
}

/** Creates a placeholder node named `#token` inside `parent`, stacked below
 * the current bounding box of `parent`'s existing children so it never
 * overlaps them. Text-ish tokens (the default) get a TEXT node whose
 * characters read `#token` (handy as a self-documenting placeholder for
 * whoever wires up the data-fill step); tokens that look image-related
 * (matching /image|photo|icon|logo/i) get a light-grey RECTANGLE instead,
 * since a real data-fill step will usually swap that node's fill for a
 * fetched image rather than set text characters on it. */
export async function createPlaceholder(parent: FrameNode | ComponentNode, token: string): Promise<SceneNode> {
  const { minX, maxY } = computeChildrenBoundingBox(parent);
  const gap = 16;

  if (IMAGE_LIKE_PATTERN.test(token)) {
    const rect = figma.createRectangle();
    rect.name = `#${token}`;
    rect.resize(160, 120);
    rect.x = minX;
    rect.y = maxY + gap;
    rect.fills = [{ type: 'SOLID', color: { r: 0.86, g: 0.86, b: 0.86 } }];
    parent.appendChild(rect);
    return rect;
  }

  const text = figma.createText();
  const font = await loadSafeDefaultFont();
  text.fontName = font;
  text.characters = `#${token}`;
  text.name = `#${token}`;
  text.x = minX;
  text.y = maxY + gap;
  parent.appendChild(text);
  return text;
}
