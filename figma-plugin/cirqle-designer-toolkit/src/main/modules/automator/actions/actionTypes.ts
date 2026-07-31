/**
 * Automator action catalogue. Every action operates on a resolved list of
 * SceneNodes (see actionRegistry.ts) and takes a small, plain-data params
 * object. Params must stay JSON-serialisable — macros (sequences of
 * { actionType, params }) get persisted verbatim to figma.clientStorage and
 * round-tripped through postMessage, so no functions/class instances/Dates
 * belong in here, only primitives/arrays/plain objects.
 *
 * NOTE ON RUNTIME BOUNDARY: this file only contains plain TypeScript types —
 * no Figma-typings-only shapes — so it's safe to import from actionRegistry
 * (main thread) and to eyeball while writing the UI's param forms. The UI
 * does NOT import this file directly, though (src/ui/** must never import
 * from src/main/**) — AutomatorPage.tsx keeps its own small duplicate of the
 * ActionType union and per-action field list, by design.
 */

export type ActionType =
  | 'rename'
  | 'resize'
  | 'move'
  | 'align'
  | 'distribute'
  | 'rotate'
  | 'scale'
  | 'roundCorners'
  | 'replaceColor'
  | 'replaceFont'
  | 'replaceImage'
  | 'swapComponent'
  | 'createComponent'
  | 'applyAutoLayout'
  | 'updateVariable'
  | 'export'
  | 'duplicate'
  | 'delete'
  | 'group'
  | 'ungroup';

/** `pattern` may contain `{n}` (or `{nn}` for zero-padded) which gets
 * replaced with the 1-based index of the node within the run, offset by
 * `start` (default 1). Kept intentionally simple — this is NOT the Rename
 * module's token engine (no {type}/{parent}/{page}/{date}), just enough
 * numbering support for macro convenience. */
export interface RenameActionParams {
  pattern: string;
  start?: number;
  padding?: number;
}

export interface ResizeActionParams {
  mode: 'absolute' | 'percentage';
  width?: number;
  height?: number;
  percentage?: number;
}

export interface MoveActionParams {
  dx: number;
  dy: number;
}

export type AlignMode = 'left' | 'right' | 'center-h' | 'top' | 'bottom' | 'center-v';

export interface AlignActionParams {
  mode: AlignMode;
}

export interface DistributeActionParams {
  axis: 'horizontal' | 'vertical';
}

export interface RotateActionParams {
  degrees: number;
}

export interface ScaleActionParams {
  factor: number;
}

export interface RoundCornersActionParams {
  radius: number;
}

export interface ReplaceColorActionParams {
  fromHex: string;
  toHex: string;
  tolerance: number;
}

export interface ReplaceFontActionParams {
  fromFamily: string;
  fromStyle: string;
  toFamily: string;
  toStyle: string;
}

/** `imageBytes` is a plain number array (JSON-serialisable) — the caller on
 * the main thread reconstructs it into a Uint8Array before calling
 * figma.createImage. Sending real binary across postMessage/clientStorage
 * isn't practical, so this is a deliberate (small-image-only) trade-off. */
export interface ReplaceImageActionParams {
  imageBytes: number[];
  targetImageHash?: string;
}

export interface SwapComponentActionParams {
  targetComponentId: string;
}

export interface CreateComponentActionParams {
  namePrefix?: string;
}

export interface ApplyAutoLayoutActionParams {
  direction: 'HORIZONTAL' | 'VERTICAL';
  itemSpacing: number;
  padding: number;
}

/** `field` is a VariableBindableNodeField name, e.g. "fills", "width",
 * "characters" — kept as a plain string rather than importing the Figma
 * typings union so this file has zero figma-typings coupling. */
export interface UpdateVariableActionParams {
  variableId: string;
  field: string;
}

export interface ExportActionParams {
  format?: 'PNG' | 'JPG' | 'SVG' | 'PDF';
  scale?: number;
}

export interface DuplicateActionParams {
  offsetX?: number;
  offsetY?: number;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally paramless
export type DeleteActionParams = Record<string, never>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally paramless
export type GroupActionParams = Record<string, never>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentionally paramless
export type UngroupActionParams = Record<string, never>;

/** Maps every ActionType to its params shape — mainly useful for a future
 * fully-generic form (today's AutomatorPage hand-writes a field list per
 * action instead, see the note at the top of this file). */
export interface ActionParamsMap {
  rename: RenameActionParams;
  resize: ResizeActionParams;
  move: MoveActionParams;
  align: AlignActionParams;
  distribute: DistributeActionParams;
  rotate: RotateActionParams;
  scale: ScaleActionParams;
  roundCorners: RoundCornersActionParams;
  replaceColor: ReplaceColorActionParams;
  replaceFont: ReplaceFontActionParams;
  replaceImage: ReplaceImageActionParams;
  swapComponent: SwapComponentActionParams;
  createComponent: CreateComponentActionParams;
  applyAutoLayout: ApplyAutoLayoutActionParams;
  updateVariable: UpdateVariableActionParams;
  export: ExportActionParams;
  duplicate: DuplicateActionParams;
  delete: DeleteActionParams;
  group: GroupActionParams;
  ungroup: UngroupActionParams;
}

export const ACTION_TYPES: ActionType[] = [
  'rename',
  'resize',
  'move',
  'align',
  'distribute',
  'rotate',
  'scale',
  'roundCorners',
  'replaceColor',
  'replaceFont',
  'replaceImage',
  'swapComponent',
  'createComponent',
  'applyAutoLayout',
  'updateVariable',
  'export',
  'duplicate',
  'delete',
  'group',
  'ungroup',
];

export interface MacroStep {
  actionType: ActionType;
  params: unknown;
}

export interface Macro {
  id: string;
  name: string;
  description: string;
  steps: MacroStep[];
  createdAt: number;
  updatedAt: number;
}
