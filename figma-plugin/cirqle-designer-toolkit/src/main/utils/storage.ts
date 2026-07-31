/** JSON-over-clientStorage helpers. figma.clientStorage is per-user,
 * per-plugin, and only reachable from the main thread — this is why
 * Settings/History/Macros all route through message calls instead of the UI
 * touching storage directly. */

export async function loadJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await figma.clientStorage.getAsync(key);
    if (raw === undefined || raw === null) return fallback;
    return raw as T;
  } catch {
    return fallback;
  }
}

export async function saveJSON<T>(key: string, value: T): Promise<void> {
  await figma.clientStorage.setAsync(key, value);
}

export async function pushCapped<T>(key: string, item: T, cap: number): Promise<T[]> {
  const list = await loadJSON<T[]>(key, []);
  list.unshift(item);
  const trimmed = list.slice(0, Math.max(1, cap));
  await saveJSON(key, trimmed);
  return trimmed;
}
