/**
 * Export Manager engine: single-node export + chunked batch export across
 * (node × scale) pairs. Figma's real, native export formats are exactly
 * PNG / JPG / SVG / PDF — there is no native WebP encoder in the Plugin
 * API. When a caller asks for WEBP we export PNG bytes instead and tag the
 * result (`actualFormat: 'PNG'`, `format: 'WEBP'`) so the UI thread (which
 * has Canvas) knows to run it through '@ui/lib/image/webpEncode' before
 * treating it as a real WebP file.
 */
import type { HandlerContext } from '../../bridge';
import { processInChunksAsync } from '../../utils/chunk';

export type SupportedExportFormat = 'PNG' | 'JPG' | 'SVG' | 'PDF';
export type RequestableExportFormat = SupportedExportFormat | 'WEBP';

export interface RawExportResult {
  bytes: Uint8Array;
  actualFormat: SupportedExportFormat;
  /** The format the caller actually asked for — equals actualFormat unless
   * it was 'WEBP', in which case `bytes` are still PNG-encoded here. */
  format: RequestableExportFormat;
}

function buildExportSettings(format: SupportedExportFormat, scale: number): ExportSettings {
  if (format === 'PNG' || format === 'JPG') {
    return { format, constraint: { type: 'SCALE', value: scale } } as ExportSettings;
  }
  // SVG and PDF are vector formats: Figma's export API doesn't apply a
  // raster SCALE constraint to them (SVG has no fixed pixel size to scale
  // against, and PDF export settings don't accept a constraint at all).
  return { format } as ExportSettings;
}

export async function exportNode(node: SceneNode, format: RequestableExportFormat, scale: number): Promise<RawExportResult> {
  const actualFormat: SupportedExportFormat = format === 'WEBP' ? 'PNG' : format;
  const settings = buildExportSettings(actualFormat, scale);
  const bytes = await node.exportAsync(settings);
  return { bytes, actualFormat, format };
}

function sanitizeFilenameSegment(raw: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'layer';
}

/**
 * Figma plugins cannot write real folders to the user's disk — browser
 * downloads are always flat single files, and no filesystem API is exposed
 * to plugin UIs. We honour the "folder structure" naming-preset request by
 * BAKING it into the filename: any `/` in the resolved pattern is treated
 * as a folder separator the user configured, and is flattened into `__`,
 * e.g. a preset "{name}/{scale}x.{format}" becomes the filename
 * "ProductCard__2x.png". This does NOT create real folders on disk — the
 * UI copy says so explicitly, and this comment is the code-side version of
 * that same disclosure.
 */
export function formatExportFilename(
  pattern: string,
  tokens: { name: string; index: number; format: string; scale: number }
): string {
  // split/join instead of String.prototype.replaceAll — this project's
  // tsconfig lib is ES2020, which predates replaceAll (ES2021).
  const resolved = pattern
    .split('{name}')
    .join(sanitizeFilenameSegment(tokens.name))
    .split('{index}')
    .join(String(tokens.index))
    .split('{format}')
    .join(tokens.format.toLowerCase())
    .split('{scale}')
    .join(`${tokens.scale}x`);

  return resolved
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('__');
}

export interface ExportJobResult extends RawExportResult {
  nodeId: string;
  nodeName: string;
  scale: number;
  suggestedFilename: string;
}

/** Batch export across every (node × scale) pair, chunked via
 * processInChunksAsync since each job awaits `node.exportAsync(...)`, which
 * is comparatively slow — one raster/vector encode per job. */
export async function exportBatch(
  nodes: readonly SceneNode[],
  format: RequestableExportFormat,
  scales: number[],
  namingPreset: string,
  ctx: HandlerContext
): Promise<ExportJobResult[]> {
  const jobs: { node: SceneNode; scale: number }[] = [];
  for (const node of nodes) {
    for (const scale of scales) {
      jobs.push({ node, scale });
    }
  }

  return processInChunksAsync(
    jobs,
    async (job, index) => {
      const result = await exportNode(job.node, format, job.scale);
      const suggestedFilename = formatExportFilename(namingPreset, {
        name: job.node.name,
        index: index + 1,
        format: result.format,
        scale: job.scale,
      });
      return {
        ...result,
        nodeId: job.node.id,
        nodeName: job.node.name,
        scale: job.scale,
        suggestedFilename,
      };
    },
    { signal: ctx.signal, onProgress: (done, total) => ctx.reportProgress({ done, total, label: 'Exporting…' }) }
  );
}
