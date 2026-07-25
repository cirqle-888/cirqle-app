/**
 * Minimal Figma plugin typings — just the surface Cirqle Studio uses.
 *
 * The official package is `@figma/plugin-typings`; install it and delete this
 * file for full types (`npm i -D @figma/plugin-typings`, then add
 * "typeRoots"/"types" per its README). This subset exists so the plugin
 * type-checks strictly even on a machine that can't reach npm.
 */

interface FontName { family: string; style: string }

interface ImagePaint {
  type: 'IMAGE'
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE'
  imageHash: string | null
}
interface SolidPaint {
  type: 'SOLID'
  color: { r: number; g: number; b: number }
  opacity?: number
}
type Paint = ImagePaint | SolidPaint | { type: string; [k: string]: unknown }

interface BaseNode {
  id: string
  name: string
  type: string
  removed: boolean
  parent: (BaseNode & ChildrenMixin) | null
  visible: boolean
  clone(): SceneNode
}
interface ChildrenMixin {
  children: readonly SceneNode[]
  appendChild(node: SceneNode): void
  findAll(callback?: (node: SceneNode) => boolean): SceneNode[]
  findOne(callback: (node: SceneNode) => boolean): SceneNode | null
}
interface LayoutMixin {
  x: number
  y: number
  width: number
  height: number
  resize(width: number, height: number): void
}
interface GeometryMixin {
  fills: readonly Paint[] | symbol
}
interface ExportMixin {
  exportAsync(settings?: unknown): Promise<Uint8Array>
}

// Layout members are declared required (as in the real typings — every
// SceneNode has x/y/width/height); children/fills stay optional because
// text nodes have no children and groups have no fills.
interface SceneNode extends BaseNode, Partial<ChildrenMixin>, LayoutMixin, Partial<GeometryMixin>, Partial<ExportMixin> {
  fills?: readonly Paint[] | symbol
}

interface TextNode extends SceneNode {
  type: 'TEXT'
  characters: string
  fontName: FontName | symbol
  getRangeAllFontNames(start: number, end: number): FontName[]
}

interface ComponentNode extends SceneNode {
  type: 'COMPONENT'
  createInstance(): InstanceNode
}
interface ComponentSetNode extends SceneNode {
  type: 'COMPONENT_SET'
  defaultVariant: ComponentNode
}
interface InstanceNode extends SceneNode {
  type: 'INSTANCE'
}
interface FrameNode extends SceneNode, ChildrenMixin, LayoutMixin {
  type: 'FRAME'
  clipsContent: boolean
  fills: readonly Paint[] | symbol
  // Redeclared: SceneNode inherits these as optional (Partial<ChildrenMixin>),
  // and the optional wins in the merge — a frame always has them.
  appendChild(node: SceneNode): void
  findAll(callback?: (node: SceneNode) => boolean): SceneNode[]
}

interface PageNode extends BaseNode, ChildrenMixin {
  selection: readonly SceneNode[]
}

interface Viewport {
  scrollAndZoomIntoView(nodes: readonly SceneNode[]): void
}

interface Image { hash: string; getBytesAsync(): Promise<Uint8Array> }

interface ClientStorageAPI {
  getAsync(key: string): Promise<unknown>
  setAsync(key: string, value: unknown): Promise<void>
}

interface UIAPI {
  postMessage(msg: unknown): void
  onmessage: ((msg: any) => void) | undefined
}

interface PluginAPI {
  readonly currentPage: PageNode
  readonly viewport: Viewport
  readonly ui: UIAPI
  readonly clientStorage: ClientStorageAPI
  readonly mixed: symbol
  showUI(html: string, options?: { width?: number; height?: number; themeColors?: boolean }): void
  closePlugin(message?: string): void
  notify(message: string, options?: { error?: boolean; timeout?: number }): void
  createFrame(): FrameNode
  createImage(bytes: Uint8Array): Image
  getImageByHash(hash: string): Image | null
  getNodeByIdAsync(id: string): Promise<BaseNode | null>
  loadFontAsync(font: FontName): Promise<void>
  on(event: string, callback: () => void): void
}

declare const figma: PluginAPI
declare const __html__: string
