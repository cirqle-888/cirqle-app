/** Coordinates are percentages of the ORIGINAL image, never the cropped viewport. */
export type HotspotPoint = [number, number];
export interface PresentationHotspot { id: string; label: string; path: string; points: HotspotPoint[]; color?: string | null; colorTo?: string | null }
/**
 * Neon glow colours for a clickable area.
 *
 * Stored as a KEY, never as a hex the author typed. The value is interpolated
 * into CSS on the public site, so accepting free text would put author input
 * into a style declaration; a key can only ever resolve to one of these.
 * It also keeps the set coherent — every one of these reads as neon against
 * dark artwork, which a freely chosen colour would not.
 */
export const HOTSPOT_COLOURS = {
 /** Cirqle violet: the site's theme-color and the colour of every focus ring on it. */
 brand:'#7c5cff',
 cyan:'#4cc3ff',
 magenta:'#ff4fd8',
 mint:'#5cff9d',
 amber:'#ffb84c',
 white:'#ffffff',
} as const;
export type HotspotColour = keyof typeof HOTSPOT_COLOURS;
export const DEFAULT_HOTSPOT_COLOUR: HotspotColour = 'brand';
/**
 * Is this one of OUR preset keys?
 *
 * `hasOwnProperty`, never `in`: `'toString' in HOTSPOT_COLOURS` is true,
 * because `in` walks the prototype chain. That let 'toString', 'constructor'
 * and '__proto__' past the validator, and made the resolver hand a FUNCTION
 * to a CSS declaration.
 */
function knownColour(value: unknown): value is HotspotColour {
 return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HOTSPOT_COLOURS, value);
}
/**
 * A six-digit hex, and nothing else.
 *
 * Custom colours are allowed, which means an author-supplied string now does
 * reach a CSS declaration — so this is the only thing standing between that
 * and a style injection. Deliberately strict: no `rgb()`, no colour names, no
 * three-digit shorthand, no alpha. If it is not exactly `#` plus six hex
 * digits it is not a colour as far as this app is concerned.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;
/** A stored colour as a hex, or null when it is not a usable colour at all. */
export function normaliseGlowColour(value: unknown): string | null {
 if (knownColour(value)) return HOTSPOT_COLOURS[value];
 if (typeof value === 'string' && HEX.test(value)) return value.toLowerCase();
 return null;
}
/** Resolve a stored colour to a hex. Anything unrecognised — including an older row with no colour — falls back to the brand. */
export function hotspotColour(value: unknown): string {
 return normaliseGlowColour(value) ?? HOTSPOT_COLOURS[DEFAULT_HOTSPOT_COLOUR];
}
/** Absent is valid: every area saved before this existed has no colour and must stay loadable. */
export function validHotspotColour(value: unknown): boolean {
 return value === undefined || value === null || normaliseGlowColour(value) !== null;
}
/**
 * The two ends of an area's glow.
 *
 * One colour unless `colorTo` is set, in which case the outline runs as a
 * gradient between them and the two neon shadows take one end each — which is
 * what the original hardcoded look did by accident, with a violet inner glow
 * and a blue outer one.
 */
export function hotspotGlow(area: { color?: unknown; colorTo?: unknown }): { from: string; to: string } {
 const from = hotspotColour(area.color);
 const to = normaliseGlowColour(area.colorTo);
 return { from, to: to ?? from };
}
/** True when the two ends differ, i.e. this area actually renders a gradient. */
export function hasGradient(area: { color?: unknown; colorTo?: unknown }): boolean {
 const { from, to } = hotspotGlow(area);
 return from !== to;
}
export interface PresentationHotspots { desktop: PresentationHotspot[]; mobile: PresentationHotspot[] }
export const emptyHotspots = (): PresentationHotspots => ({ desktop: [], mobile: [] });
export function validGalleryPath(path: unknown): path is string {
 return typeof path === 'string' && path.length <= 240 && /^\/portfolio(?:\/[a-z0-9-]+){1,2}$/.test(path);
}
export function validHotspots(value: unknown): value is PresentationHotspots {
 if (!value || typeof value !== 'object') return false;
 return ['desktop','mobile'].every(side => {
  const rows = (value as Record<string, unknown>)[side];
  return Array.isArray(rows) && rows.length <= 8 && new Set(rows.map(r=>r?.id)).size === rows.length && rows.every(r =>
   r && typeof r.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(r.id) && typeof r.label === 'string' && r.label.trim().length > 0 && r.label.length <= 80 && validGalleryPath(r.path) && validHotspotColour(r.color) && validHotspotColour(r.colorTo) && Array.isArray(r.points) && r.points.length >= 3 && r.points.length <= 16 && r.points.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(n=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=100)) && Math.abs(r.points.reduce((sum: number,p: HotspotPoint,i: number)=>{const q=r.points[(i+1)%r.points.length];return sum+p[0]*q[1]-q[0]*p[1];},0)) > 2);
 });
}
export function readHotspots(value: unknown): PresentationHotspots { return validHotspots(value) ? value : emptyHotspots(); }
/** Exact CSS object-fit:cover / object-position geometry. */
export function coverBox(width: number, height: number, sourceWidth: number, sourceHeight: number, x: number, y: number) {
 const scale=Math.max(width/sourceWidth,height/sourceHeight);
 const w=sourceWidth*scale,h=sourceHeight*scale;
 return {width:w,height:h,left:(width-w)*x/100,top:(height-h)*y/100};
}
