/**
 * Cirqle Studio — main-thread (sandbox) code.
 *
 * This half owns the Figma document: scanning for card templates, duplicating
 * them, filling layers, placing images. It has no network access by design —
 * every byte arrives from ui.html, which talks to the Cirqle API.
 *
 * Hard rules enforced here:
 *  - Only the CURRENT page is ever modified. Nothing touches other pages.
 *  - Layer matching supports the existing Google-Sheets-plugin convention
 *    (#product, #offerprice, …) plus common human aliases — designers never
 *    rename a working template.
 *  - Every failure is reported as { what, where, fix }; nothing throws
 *    uncaught past the message router.
 */

figma.showUI(__html__, { width: 380, height: 720, themeColors: true })

/* ================================================================== *
 * Layer-name matching
 * ================================================================== */

/**
 * Alias → canonical token. The right side is the sheet-derived name
 * (`#` + column, lowercased, no spaces) that the API's `bindings.layers`
 * emits. The left side is what designers actually type on layers.
 *
 * The canonical names themselves always match (identity), so an existing
 * Sheets-plugin template needs zero renames — aliases only ADD tolerance.
 */
const TOKEN_ALIASES: Record<string, string> = {
  '#name': '#product',
  '#productname': '#product',
  '#title': '#offertitle',
  '#price': '#offerprice',
  '#sellingprice': '#offerprice',
  '#saleprice': '#offerprice',
  '#oldprice': '#mrp',
  '#strikeprice': '#mrp',
  '#originalprice': '#mrp',
  '#badge': '#badges',
  '#offer': '#offertext',
  '#image': '#imageurl',
  '#photo': '#imageurl',
  '#img': '#imageurl',
  '#productimage': '#imageurl',
  '#date': '#offerdatedisplay',
  '#size': '#weight',
  '#qty': '#weight',
}

function normalizeLayerName(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * The 17 columns of the sheet contract (src/lib/offer-sheet.ts), as layer
 * names. Only needed to tell a numbered layer apart from a real token —
 * "#price1" is a token, "#product-1" is #product for product number 1.
 */
const CANONICAL_TOKENS: Record<string, boolean> = {
  '#pagenumber': true, '#displayorder': true, '#product': true, '#weight': true,
  '#offertype': true, '#offerprice': true, '#mrp': true, '#offertext': true,
  '#badges': true, '#imageurl': true, '#offertitle': true, '#offerdate': true,
  '#client': true, '#price1': true, '#price2': true,
  '#offerdatedisplay': true, '#offerdatetext': true,
}

/**
 * A layer name resolved to what it binds to.
 *
 * `index` is the explicit product number in "#product-3" / "#product_3" /
 * "#product 3" — the escape hatch for names that were pulled out of the card
 * so they could be moved freely. A separator is REQUIRED, which is what keeps
 * "#price1" and "#price2" reading as themselves rather than as "#price" 1 and 2.
 */
function layerBinding(raw: string): { token: string; index: number | null } | null {
  const compact = normalizeLayerName(raw)
  if (!compact.startsWith('#')) return null

  const alias = TOKEN_ALIASES[compact]
  if (alias) return { token: alias, index: null }
  if (CANONICAL_TOKENS[compact]) return { token: compact, index: null }

  // Spaces become '-' so "#product 3" reads the same as "#product-3".
  const spaced = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-')
  const m = /^(#[a-z0-9]+)[-_](\d+)$/.exec(spaced)
  if (m) {
    const base = TOKEN_ALIASES[m[1]] || m[1]
    if (CANONICAL_TOKENS[base]) return { token: base, index: parseInt(m[2], 10) }
  }
  return { token: compact, index: null }   // unknown #token — reported by Validate
}

/** Resolve a layer name to its canonical data token, or null if it isn't one. */
function layerToken(raw: string): string | null {
  const bound = layerBinding(raw)
  return bound ? bound.token : null
}

/** The explicit product number on a layer, or null when it has none. */
function layerIndex(raw: string): number | null {
  const bound = layerBinding(raw)
  return bound ? bound.index : null
}

const IMAGE_TOKEN = '#imageurl'

/* ================================================================== *
 * Small helpers
 * ================================================================== */

function isText(node: SceneNode): node is TextNode {
  return node.type === 'TEXT'
}

function descendantsOf(root: SceneNode): SceneNode[] {
  const self = [root]
  if ('findAll' in root && typeof root.findAll === 'function') {
    return self.concat(root.findAll(() => true))
  }
  return self
}

/**
 * Every font in a text node must load before characters can change; a mixed-
 * font node needs each range font. Missing fonts are surfaced as a fix-it
 * message naming the font, not as a dead build.
 */
async function loadFontsFor(node: TextNode): Promise<void> {
  const len = node.characters.length
  if (len > 0) {
    for (const font of node.getRangeAllFontNames(0, len)) {
      await figma.loadFontAsync(font)
    }
    return
  }
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName as FontName)
    return
  }
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
}

/** Neutral gray placeholder fill for products with no photo. */
const PLACEHOLDER_FILL: SolidPaint = {
  type: 'SOLID',
  color: { r: 0.898, g: 0.906, b: 0.922 }, // #E5E7EB
}

function setImageFill(node: SceneNode, bytes: Uint8Array): void {
  const image = figma.createImage(bytes)
  let scaleMode: ImagePaint['scaleMode'] = 'FILL' // FILL = cover + centered crop
  if (node.fills && node.fills !== figma.mixed) {
    const existing = (node.fills as readonly Paint[]).find(f => f.type === 'IMAGE') as ImagePaint | undefined
    if (existing && existing.scaleMode && existing.scaleMode !== 'CROP') {
      scaleMode = existing.scaleMode
    }
  }
  ;(node as { fills?: readonly Paint[] }).fills = [{ type: 'IMAGE', scaleMode, imageHash: image.hash }]
}

function setPlaceholderFill(node: SceneNode): void {
  ;(node as { fills?: readonly Paint[] }).fills = [PLACEHOLDER_FILL]
}

function fail(what: string, where: string, fix: string): void {
  figma.ui.postMessage({ type: 'error', what, where, fix })
}

/* ================================================================== *
 * Product slots — single cards vs. whole-page templates
 * ================================================================== *
 * A template can be either shape, and designers here use both:
 *   · a single product card, repeated by the plugin into a grid, or
 *   · a finished A4 page already laid out with N product cards on it.
 *
 * Telling them apart matters enormously. Treating a 22-slot A4 page as one
 * card duplicates the whole page 22 times and stamps the SAME product name
 * into all 22 of its name layers — which is exactly what happened on the
 * first real run. Counting #product layers distinguishes the two reliably.
 * ================================================================== */

/**
 * Where slots should be counted. A component set is a stack of alternatives,
 * not a layout: only one variant is ever instantiated, so counting across all
 * of them would read a 6-variant card as a 6-slot page and pour six different
 * products into what is really one card.
 */
function slotRoot(node: SceneNode): SceneNode {
  if (node.type === 'COMPONENT_SET') {
    const variant = (node as ComponentSetNode).defaultVariant
    if (variant) return variant as SceneNode
    const kids = node.children || []
    if (kids.length) return kids[0]
  }
  return node
}

/**
 * Which layer name repeats once per product. Usually `#product`, but not
 * always: pull the names out of the cards into their own component and the
 * photos become the thing that repeats. Whichever occurs most often defines
 * how many products fit on the page.
 *
 * Order matters only for ties — `>` keeps the first maximum, so `#product`
 * still wins whenever it is as common as anything else.
 */
const ANCHOR_TOKENS = ['#product', '#imageurl', '#price1', '#offerprice', '#mrp', '#weight']

function bestAnchor(root: SceneNode): { token: string; layers: SceneNode[] } {
  const all = descendantsOf(slotRoot(root))
  let token = '#product'
  let layers: SceneNode[] = []
  for (const candidate of ANCHOR_TOKENS) {
    const hits = all.filter(n => layerToken(n.name) === candidate)
    if (hits.length > layers.length) { layers = hits; token = candidate }
  }
  return { token, layers }
}

/** The layers that repeat once per product — one per slot. */
function productLayersIn(root: SceneNode): SceneNode[] {
  return bestAnchor(root).layers
}

/**
 * Sort the way a flyer reads: top row left-to-right, then down. Nested slots
 * must be compared by absolute position — x/y are relative to the immediate
 * parent, so two cards in different groups aren't otherwise comparable.
 */
const ROW_TOLERANCE = 8 // px; cards nudged a few px apart are still one row

function readingOrder(nodes: SceneNode[]): SceneNode[] {
  const at = (n: SceneNode) => n.absoluteBoundingBox || { x: n.x, y: n.y }
  return nodes.slice().sort((a, b) => {
    const p = at(a), q = at(b)
    return Math.abs(p.y - q.y) > ROW_TOLERANCE ? p.y - q.y : p.x - q.x
  })
}

/**
 * One slot = one product's worth of template. A single-card template has one
 * (itself); a page laid out with 22 cards has 22.
 *
 * Boundaries are found by climbing from each anchor layer towards the root and
 * stopping just before the first ancestor that would swallow a second one —
 * which lands exactly on the repeated card group the designer drew, without
 * requiring any naming convention beyond the `#` layers already in use.
 */
function findSlots(template: SceneNode): SceneNode[] {
  // The anchor token is decided ONCE, for the template as a whole. Re-deciding
  // it per ancestor would let a sub-group vote for a different layer name and
  // cut the slot in the wrong place.
  const anchor = bestAnchor(template)
  const leaves = anchor.layers
  if (leaves.length <= 1) return [template]

  const counts: Record<string, number> = {}
  const productCount = (node: SceneNode): number => {
    if (counts[node.id] === undefined) {
      counts[node.id] = descendantsOf(node).filter(n => layerToken(n.name) === anchor.token).length
    }
    return counts[node.id]
  }

  const slots: SceneNode[] = []
  const seen = new Set<string>()
  for (const leaf of leaves) {
    let slot: SceneNode = leaf
    let node: BaseNode = leaf
    while (node.parent && node.parent.id !== template.id && node.parent.type !== 'PAGE') {
      const parent = node.parent as unknown as SceneNode
      if (productCount(parent) > 1) break
      slot = parent
      node = parent
    }
    if (seen.has(slot.id)) continue
    seen.add(slot.id)
    slots.push(slot)
  }
  return readingOrder(slots)
}

/** Every node id inside the given subtrees — used to keep slot and page fills apart. */
function subtreeIds(nodes: SceneNode[]): Set<string> {
  const ids = new Set<string>()
  for (const root of nodes) for (const node of descendantsOf(root)) ids.add(node.id)
  return ids
}

/* ================================================================== *
 * Template scanning
 * ================================================================== */

type TemplateInfo = { id: string; name: string; nodeType: string; tokens: string[]; slots: number }

/**
 * A "template" is any component/frame on the CURRENT page whose descendants
 * include at least one #token layer. Components are preferred (instances stay
 * linked), but plain frames work — many real templates are frames.
 */
function scanTemplates(): TemplateInfo[] {
  const results: TemplateInfo[] = []
  const roots = figma.currentPage.findAll(n =>
    n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'FRAME' || n.type === 'INSTANCE'
  )
  for (const root of roots) {
    // A nested candidate inside another candidate is noise — only offer
    // top-level-ish nodes (parent is the page or a section-like container).
    const parentType = root.parent ? root.parent.type : 'PAGE'
    if (parentType !== 'PAGE' && parentType !== 'SECTION') continue

    const tokens = new Set<string>()
    for (const node of descendantsOf(root)) {
      const token = layerToken(node.name)
      if (token) tokens.add(token)
    }
    if (tokens.size > 0) {
      results.push({
        id: root.id, name: root.name, nodeType: root.type,
        tokens: Array.from(tokens).sort(),
        slots: productLayersIn(root).length,
      })
    }
  }
  return results
}

/* ================================================================== *
 * Template validation (document side — data checks live in the UI)
 * ================================================================== */

async function validateTemplate(msg: { templateId: string }): Promise<void> {
  const issues: { severity: string; area: string; message: string; fix: string }[] = []
  const template = (await figma.getNodeByIdAsync(msg.templateId)) as SceneNode | null

  if (!template || template.removed) {
    figma.ui.postMessage({
      type: 'template-validated',
      issues: [{
        severity: 'error', area: 'template',
        message: 'The selected template no longer exists on this page.',
        fix: 'Press Refresh to re-scan templates, then pick one again.',
      }],
      tokens: [],
    })
    return
  }

  const tokens = new Set<string>()
  let textTokens = 0
  for (const node of descendantsOf(template)) {
    const token = layerToken(node.name)
    if (!token) continue
    tokens.add(token)
    if (isText(node)) textTokens++
    if (token === IMAGE_TOKEN && isText(node)) {
      issues.push({
        severity: 'warning', area: 'template',
        message: `"${node.name}" is a TEXT layer but should be a shape/frame — images become fills, not characters.`,
        fix: 'Rename the text layer, and name the picture rectangle #imageurl instead.',
      })
    }
  }

  const slotCount = findSlots(template).length
  const isPage = productLayersIn(template).length > 1

  if (!tokens.has('#product')) {
    issues.push({
      severity: 'error', area: 'template',
      message: 'No #product layer found — cards would build with no product name.',
      fix: 'Name the product-name text layer "#product" (aliases: #name, #productname).',
    })
  }
  if (isPage) {
    issues.push({
      severity: 'info', area: 'template',
      message: `This is a full page template with ${slotCount} product slots — one page will be built per ${slotCount} products, filled top-left to bottom-right.`,
      fix: 'If you meant one card per product instead, pick the single card as the template rather than the whole page.',
    })
  }
  // The #price1/#price2 pair is a complete price design in its own right —
  // warning about a missing #offerprice on top of it would be noise on a
  // perfectly correct template (the generated one uses exactly that pair).
  const hasPricePair = tokens.has('#price1') && tokens.has('#price2')
  if (!tokens.has('#offerprice') && !hasPricePair) {
    issues.push({
      severity: 'warning', area: 'template',
      message: 'No price layer found — prices will not appear.',
      fix: 'Name the price text layer "#offerprice" (alias: #price), or use the two-layer form "#price1" for rupees and "#price2" for paise. Skip if this template is price-free on purpose.',
    })
  }
  if (!tokens.has(IMAGE_TOKEN)) {
    issues.push({
      severity: 'warning', area: 'template',
      message: 'No #imageurl layer found — product photos will not be placed.',
      fix: 'Name the photo rectangle/frame "#imageurl" (aliases: #image, #photo).',
    })
  }

  // Two-layer price designs pair #price1 (rupees) with #price2 (paise).
  // Half a pair is worse than neither: ₹20.99 would print as a confident
  // "20" with the paise silently dropped, and nothing on the flyer shows
  // that anything is missing.
  const hasP1 = tokens.has('#price1')
  const hasP2 = tokens.has('#price2')
  if (hasP1 !== hasP2) {
    issues.push({
      severity: 'warning', area: 'template',
      message: hasP1
        ? 'Template has #price1 but no #price2 — the paise of a price like ₹20.99 would be dropped silently.'
        : 'Template has #price2 but no #price1 — the rupees of the price would be missing.',
      fix: hasP1
        ? 'Add a small text layer named "#price2" next to it, or use a single #offerprice layer instead.'
        : 'Add a text layer named "#price1" for the rupees, or use a single #offerprice layer instead.',
    })
  }
  if (hasP1 && hasP2 && tokens.has('#offerprice')) {
    issues.push({
      severity: 'warning', area: 'template',
      message: 'Template has both #offerprice and the #price1/#price2 pair — the price will appear twice.',
      fix: 'Keep whichever the design uses and rename the other (e.g. to "price-old") so it stops receiving data.',
    })
  }
  if (textTokens === 0) {
    issues.push({
      severity: 'error', area: 'template',
      message: 'The template has #-layers but none of them are text layers.',
      fix: 'Data fills TEXT layers; check the layer types in the template.',
    })
  }

  figma.ui.postMessage({ type: 'template-validated', issues, tokens: Array.from(tokens).sort(), slots: slotCount })
}

/* ================================================================== *
 * Build
 * ================================================================== */

type BuildProduct = {
  fields: Record<string, string>
  image: Uint8Array | null
  hasImageUrl: boolean
}

async function makeCard(template: SceneNode): Promise<SceneNode> {
  if (template.type === 'COMPONENT') return (template as ComponentNode).createInstance()
  if (template.type === 'COMPONENT_SET') return (template as ComponentSetNode).defaultVariant.createInstance()
  return template.clone()
}

type ApplyResult = 'filled' | 'hidden' | 'image' | 'placeholder' | 'skip'

/** Put one product field into one layer. The single place data touches Figma. */
async function applyToken(node: SceneNode, token: string, product: BuildProduct): Promise<ApplyResult> {
  if (token === IMAGE_TOKEN) {
    if (isText(node)) return 'skip'   // warned during validation; never fatal here
    if (product.image) { setImageFill(node, product.image); return 'image' }
    setPlaceholderFill(node)
    return 'placeholder'
  }
  if (!isText(node)) return 'skip'
  const value = product.fields[token]
  if (value === undefined) return 'skip'
  if (value === '') {
    // Hide, don't print blanks: an empty MRP layer would leave a floating
    // strikethrough on the printed flyer.
    node.visible = false
    return 'hidden'
  }
  node.visible = true
  await loadFontsFor(node)
  ;(node as TextNode).characters = value
  return 'filled'
}

/**
 * @param skip  node ids to leave alone — used when a page's slots have already
 *              been filled with their own products and only the layers around
 *              them are left.
 */
async function fillCard(
  card: SceneNode,
  product: BuildProduct,
  skip?: Set<string>,
): Promise<{ filled: number; missing: string[]; imageState: 'placed' | 'placeholder' | 'none' }> {
  let filled = 0
  const matched = new Set<string>()
  let imageState: 'placed' | 'placeholder' | 'none' = 'none'

  for (const node of descendantsOf(card)) {
    if (skip && skip.has(node.id)) continue
    const token = layerToken(node.name)
    if (!token) continue
    const result = await applyToken(node, token, product)
    if (result === 'skip') continue
    matched.add(token)
    if (result === 'filled' || result === 'image') filled++
    if (result === 'image') imageState = 'placed'
    if (result === 'placeholder' && imageState !== 'placed') imageState = 'placeholder'
  }

  const missing = Object.keys(product.fields)
    .filter(t => product.fields[t] !== '' && !matched.has(t))
  return { filled, missing, imageState }
}

/**
 * Layers that belong to a product but live OUTSIDE the cards.
 *
 * This is the "the product name is in its own component so I can move it
 * freely" case: the photo and price sit in one card while all 22 names sit
 * somewhere else on the page. Two ways to bind them, explicit beating implicit:
 *
 *  1. **`#product-3`** — an explicit product number. Position is irrelevant;
 *     move the layer anywhere, it still receives product 3.
 *  2. **reading order within that layer name** — the 1st `#product` on the page
 *     gets product 1, the 2nd gets product 2, and so on. Each layer name is
 *     ordered independently, so names above their photos and prices below them
 *     still line up.
 *
 * A name that appears exactly ONCE is a heading for the whole page
 * (`#offertitle`, `#client`, `#offerdate`) and is filled from its first product.
 */
async function fillLooseLayers(
  root: SceneNode,
  products: BuildProduct[],
  firstIndex: number,
  skip: Set<string>,
  hideUnused: boolean,
): Promise<{ filled: number; bound: number; unbound: number; imagesPlaced: number; placeholders: number }> {
  const report = { filled: 0, bound: 0, unbound: 0, imagesPlaced: 0, placeholders: 0 }
  const tally = (r: ApplyResult) => {
    if (r === 'skip') return
    report.bound++
    if (r === 'filled' || r === 'image') report.filled++
    if (r === 'image') report.imagesPlaced++
    if (r === 'placeholder') report.placeholders++
  }

  const numbered: SceneNode[] = []
  const plain: SceneNode[] = []
  for (const node of descendantsOf(root)) {
    if (skip.has(node.id)) continue
    if (!layerToken(node.name)) continue
    ;(layerIndex(node.name) === null ? plain : numbered).push(node)
  }

  for (const node of numbered) {
    const index = layerIndex(node.name) as number
    const product = products[firstIndex + index - 1]
    if (!product) { report.unbound++; if (hideUnused) node.visible = false; continue }
    tally(await applyToken(node, layerToken(node.name) as string, product))
  }

  const groups: Record<string, SceneNode[]> = {}
  for (const node of plain) {
    const token = layerToken(node.name) as string
    if (!groups[token]) groups[token] = []
    groups[token].push(node)
  }

  for (const token of Object.keys(groups)) {
    const ordered = readingOrder(groups[token])
    for (let i = 0; i < ordered.length; i++) {
      // One of a kind = a page heading, so it takes the page's first product
      // (which for #offertitle / #client / #offerdate is the campaign value).
      const product = products[firstIndex + (ordered.length === 1 ? 0 : i)]
      if (!product) { report.unbound++; if (hideUnused) ordered[i].visible = false; continue }
      tally(await applyToken(ordered[i], token, product))
    }
  }

  return report
}

/**
 * Fill cards that are ALREADY on the page, in place — the Google Sheets Sync
 * behaviour designers know: select the laid-out cards, run, and the data lands
 * in them without anything moving.
 *
 * Selection order is unreliable in Figma (it follows click order, not layout),
 * so cards are sorted the way a flyer reads: top row left-to-right, then down.
 * Without this, product 1 could land in the card the designer clicked last.
 */
async function fillSelection(products: BuildProduct[]): Promise<void> {
  const selection = [...figma.currentPage.selection]
  if (selection.length === 0) {
    fail('Nothing selected.', 'Fill selected cards',
      'Select the cards you want filled, or untick "Fill selected cards" to build new ones.')
    return
  }

  // One selected page template is really a selection of its slots — otherwise
  // ticking "Fill selected cards" on an A4 page would fill only product 1.
  const wholePage = selection.length === 1 && productLayersIn(selection[0]).length > 1
  const expanded = wholePage ? findSlots(selection[0]) : selection
  const cards = readingOrder(expanded)

  const report = {
    cards: 0, layersFilled: 0, imagesPlaced: 0, placeholders: 0,
    missingLayerCounts: {} as Record<string, number>,
    filledInPlace: true as boolean,
    overflow: 0,
    looseLayers: 0,
  }

  const pairs = Math.min(cards.length, products.length)
  for (let i = 0; i < pairs; i++) {
    try {
      const res = await fillCard(cards[i], products[i])
      report.cards++
      report.layersFilled += res.filled
      if (res.imageState === 'placed') report.imagesPlaced++
      if (res.imageState === 'placeholder') report.placeholders++
      for (const token of res.missing) {
        report.missingLayerCounts[token] = (report.missingLayerCounts[token] || 0) + 1
      }
    } catch (err) {
      fail(
        'Card ' + (i + 1) + ' (' + cards[i].name + ') could not be filled completely.',
        'Fill selected cards',
        (err instanceof Error ? err.message : String(err)) +
          ' — if this mentions a font, install/enable that font and run again.',
      )
    }
    figma.ui.postMessage({ type: 'progress', done: i + 1, total: pairs })
  }

  // Names, prices or photos kept OUTSIDE the cards — the "moved it into its
  // own component" case. Only when a whole page was selected, because that is
  // the only time we know what "outside the cards" means.
  if (wholePage) {
    const loose = await fillLooseLayers(selection[0], products, 0, subtreeIds(cards), false)
    report.layersFilled += loose.filled
    report.looseLayers = loose.bound
    report.imagesPlaced += loose.imagesPlaced
    report.placeholders += loose.placeholders
  }

  // Left-over cards are LEFT ALONE rather than blanked: wiping a designer's
  // work because the list was short is unrecoverable, a stale card is not.
  if (products.length > cards.length) report.overflow = products.length - cards.length

  figma.ui.postMessage({ type: 'build-done', report })
  figma.notify(
    `Cirqle Studio: filled ${report.cards} selected card${report.cards === 1 ? '' : 's'}` +
    (cards.length > products.length ? ` (${cards.length - products.length} left untouched)` : ''),
  )
}

async function buildFlyer(msg: {
  templateId: string
  products: BuildProduct[]
  columns: number
  gap: number
  frameName: string
  fillSelection?: boolean
}): Promise<void> {
  if (msg.fillSelection) {
    await fillSelection(msg.products)
    return
  }

  const template = (await figma.getNodeByIdAsync(msg.templateId)) as SceneNode | null
  if (!template || template.removed) {
    fail(
      'Build could not start.',
      'Template lookup',
      'The chosen template was deleted or moved to another page. Press Refresh and pick a template again.',
    )
    return
  }
  if (msg.products.length === 0) {
    fail('Nothing to build.', 'Product list', 'The selected offer/page has no products. Pick another page or offer.')
    return
  }

  const slots = findSlots(template)
  const perPage = slots.length

  const width = (template as FrameNode).width || 200
  const height = (template as FrameNode).height || 200
  const gap = Number.isFinite(msg.gap) ? msg.gap : 40
  // A page template produces one copy per N products, not one copy per product.
  const copies = perPage > 1 ? Math.ceil(msg.products.length / perPage) : msg.products.length
  const cols = Math.max(1, Math.min(msg.columns || 4, copies))
  const rows = Math.ceil(copies / cols)

  // Everything lands inside ONE new frame on the CURRENT page — the plugin
  // never edits existing nodes and never touches other pages.
  const wrapper = figma.createFrame()
  wrapper.name = msg.frameName || 'Cirqle Studio build'
  wrapper.fills = []
  wrapper.clipsContent = false
  wrapper.x = ((template as FrameNode).x || 0)
  wrapper.y = ((template as FrameNode).y || 0) + height + gap * 2
  wrapper.resize(
    Math.max(1, cols * width + (cols - 1) * gap),
    Math.max(1, rows * height + (rows - 1) * gap),
  )
  figma.currentPage.appendChild(wrapper)

  const report = {
    cards: 0,
    layersFilled: 0,
    imagesPlaced: 0,
    placeholders: 0,
    missingLayerCounts: {} as Record<string, number>,
    pages: perPage > 1 ? copies : 0,
    slotsPerPage: perPage > 1 ? perPage : 0,
    unusedSlots: 0,
    looseLayers: 0,
  }

  const tally = (res: { filled: number; missing: string[]; imageState: string }) => {
    report.layersFilled += res.filled
    if (res.imageState === 'placed') report.imagesPlaced++
    if (res.imageState === 'placeholder') report.placeholders++
    for (const token of res.missing) {
      report.missingLayerCounts[token] = (report.missingLayerCounts[token] || 0) + 1
    }
  }

  for (let copy = 0; copy < copies; copy++) {
    let card: SceneNode
    try {
      card = await makeCard(template)
    } catch (err) {
      fail(
        'Could not duplicate the template (copy ' + (copy + 1) + ').',
        'Card creation',
        (err instanceof Error ? err.message : String(err)) + ' — check the template is not locked.',
      )
      continue
    }
    wrapper.appendChild(card)
    ;(card as FrameNode).x = (copy % cols) * (width + gap)
    ;(card as FrameNode).y = Math.floor(copy / cols) * (height + gap)

    try {
      if (perPage > 1) {
        /* --- Page template: one copy holds `perPage` products ----------- */
        const cardSlots = findSlots(card)
        const first = copy * perPage
        card.name = (msg.frameName || 'Page') + ' — page ' + (copy + 1)

        for (let s = 0; s < cardSlots.length; s++) {
          const product = msg.products[first + s]
          if (!product) {
            // A slot with no product left keeps the template's sample content,
            // which would print as a real offer. Hidden, not deleted — one
            // click brings it back if the list grows.
            cardSlots[s].visible = false
            report.unusedSlots++
            continue
          }
          tally(await fillCard(cardSlots[s], product))
          report.cards++
        }

        // Anything named outside the slots — page headings, and product names
        // kept in their own component so they can be moved freely.
        const loose = await fillLooseLayers(card, msg.products, first, subtreeIds(cardSlots), true)
        report.layersFilled += loose.filled
        report.looseLayers += loose.bound
        report.imagesPlaced += loose.imagesPlaced
        report.placeholders += loose.placeholders
      } else {
        /* --- Single-card template: one copy per product ------------------ */
        card.name = msg.products[copy].fields['#product'] || `Product ${copy + 1}`
        tally(await fillCard(card, msg.products[copy]))
        report.cards++
      }
    } catch (err) {
      // Most common real cause: a font Figma can't load.
      fail(
        (perPage > 1 ? 'Page ' : 'Card ') + (copy + 1) + ' (' + card.name + ') could not be filled completely.',
        'Layer fill',
        (err instanceof Error ? err.message : String(err)) +
          ' — if this mentions a font, install/enable that font and rebuild.',
      )
    }

    figma.ui.postMessage({ type: 'progress', done: copy + 1, total: copies })
  }

  figma.currentPage.selection = [wrapper]
  figma.viewport.scrollAndZoomIntoView([wrapper])
  figma.ui.postMessage({ type: 'build-done', report })
  figma.notify(
    perPage > 1
      ? `Cirqle Studio: built ${copies} page${copies === 1 ? '' : 's'}, ${report.cards} products placed.`
      : `Cirqle Studio: built ${report.cards} card${report.cards === 1 ? '' : 's'}.`,
  )
}

/* ================================================================== *
 * Card template generator
 * ================================================================== *
 * Builds a real component set to start from, with the layer names already
 * correct. Both failures on the first production runs traced back to hand-made
 * templates — one had no #offerprice at all, another had 22 #product layers on
 * one page — so the fastest way to a working template is to generate one.
 *
 * It is a STARTING POINT, not a house style: colours, radii, fonts and the
 * photo shape are all meant to be restyled in Figma. Only the names matter.
 * ================================================================== */

const CARD_FONT = 'Inter'

const COLOR = {
  red:   { r: 0.831, g: 0.125, b: 0.153 }, // #D42027
  navy:  { r: 0.106, g: 0.212, b: 0.365 }, // #1B365D
  ink:   { r: 0.102, g: 0.102, b: 0.118 }, // #1A1A1E — flyer product names
  gray:  { r: 0.420, g: 0.447, b: 0.502 }, // #6B7280
  faint: { r: 0.612, g: 0.639, b: 0.686 }, // #9CA3AF
  white: { r: 1, g: 1, b: 1 },
  media: { r: 1, g: 0.965, b: 0.890 },     // #FFF6E3
  line:  { r: 0.914, g: 0.918, b: 0.933 }, // #E9EAEE
  photo: { r: 0.898, g: 0.906, b: 0.922 }, // #E5E7EB
}

type RGB = { r: number; g: number; b: number }
function paint(c: RGB): SolidPaint[] {
  return [{ type: 'SOLID', color: c }]
}

/**
 * Figma always ships Inter, but a locked-down install may not have every
 * weight. Each request falls back down the weight chain rather than failing
 * the whole build over a missing "Extra Bold".
 */
const loadedFonts: Record<string, boolean> = {}
async function useFont(style: string): Promise<FontName> {
  for (const candidate of [style, 'Bold', 'Regular']) {
    if (loadedFonts[candidate]) return { family: CARD_FONT, style: candidate }
    try {
      await figma.loadFontAsync({ family: CARD_FONT, style: candidate })
      loadedFonts[candidate] = true
      return { family: CARD_FONT, style: candidate }
    } catch (err) { /* try the next weight down */ }
  }
  throw new Error('The Inter font is not available in this Figma install.')
}

type LabelOpts = {
  size: number
  color: RGB
  weight?: string
  align?: 'LEFT' | 'CENTER' | 'RIGHT'
  resize?: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT'
  strike?: boolean
  upper?: boolean
  tracking?: number
}

async function label(name: string, chars: string, o: LabelOpts): Promise<TextNode> {
  const t = figma.createText()
  t.fontName = await useFont(o.weight || 'Regular')  // must precede characters
  t.characters = chars
  t.fontSize = o.size
  t.fills = paint(o.color)
  t.name = name
  t.textAlignHorizontal = o.align || 'LEFT'
  t.textAutoResize = o.resize || 'WIDTH_AND_HEIGHT'
  if (o.strike) t.textDecoration = 'STRIKETHROUGH'
  if (o.upper) t.textCase = 'UPPER'
  if (o.tracking) t.letterSpacing = { value: o.tracking, unit: 'PERCENT' }
  return t
}

const CARD_W = 220
const PHOTO_W = 184
const PHOTO_H = 150

type CardOpts = {
  offer: 'Price' | 'B1G1' | 'Percent'
  shape: 'Circle' | 'Pill'
  price: 'Whole' | 'Paise'
}

/**
 * Modelled on the real Sea Star / Goodwill / Hyper Happy Mart flyers rather
 * than on a generic web card: no container box (the card sits straight on the
 * flyer background), a cut-out product photo, the price badge overlapping the
 * photo's bottom-right, the struck MRP *above* the price inside that badge,
 * and the product name on one line with the pack size under it.
 */
async function buildCardComponent(o: CardOpts): Promise<ComponentNode> {
  const card = figma.createComponent()
  card.name = 'Offer=' + o.offer + ', Shape=' + o.shape + ', Price=' + o.price
  card.resize(CARD_W, 240)
  card.fills = []              // transparent — the flyer background shows through
  card.layoutMode = 'VERTICAL'
  card.primaryAxisSizingMode = 'AUTO'
  card.counterAxisSizingMode = 'FIXED'
  card.counterAxisAlignItems = 'CENTER'
  card.itemSpacing = 6
  card.paddingLeft = 8; card.paddingRight = 8
  card.paddingTop = 8; card.paddingBottom = 8

  /* --- photo, with the badges floating over it --------------------- */
  const media = figma.createFrame()
  media.name = 'Photo'
  media.resize(PHOTO_W, PHOTO_H)
  media.fills = []
  media.layoutMode = 'NONE'
  media.clipsContent = false   // the price badge deliberately overhangs
  card.appendChild(media)

  const photo = figma.createRectangle()
  photo.name = '#imageurl'
  photo.resize(PHOTO_W, PHOTO_H)
  photo.x = 0; photo.y = 0
  photo.cornerRadius = 6
  photo.fills = paint(COLOR.photo)
  media.appendChild(photo)

  // Offer ribbon — top-left, the way "BUY 1 GET 1 FREE" and "FLAT 50 % OFF"
  // sit on the reference flyers. Absent on a plain price card.
  if (o.offer !== 'Price') {
    const ribbon = figma.createFrame()
    ribbon.name = 'Ribbon'
    ribbon.layoutMode = 'HORIZONTAL'
    ribbon.primaryAxisSizingMode = 'AUTO'
    ribbon.counterAxisSizingMode = 'AUTO'
    ribbon.paddingLeft = 8; ribbon.paddingRight = 8
    ribbon.paddingTop = 5; ribbon.paddingBottom = 5
    ribbon.cornerRadius = 4
    ribbon.fills = paint(o.offer === 'B1G1' ? COLOR.red : COLOR.navy)
    media.appendChild(ribbon)
    ribbon.appendChild(await label(
      '#badges',
      o.offer === 'B1G1' ? 'BUY 1 GET 1 FREE' : 'FLAT 50 % OFF',
      { size: 9, weight: 'Bold', color: COLOR.white, upper: true, tracking: 4 },
    ))
    ribbon.x = -2
    ribbon.y = 4
  }

  /* --- price badge: MRP struck on top, price under ------------------ */
  const badge = figma.createFrame()
  badge.name = 'Price badge'
  badge.layoutMode = 'VERTICAL'
  badge.primaryAxisSizingMode = 'AUTO'
  badge.counterAxisSizingMode = 'AUTO'
  badge.counterAxisAlignItems = 'CENTER'
  badge.itemSpacing = 0
  // A circle that hugs its text turns into an oval for ₹1250.50 instead of
  // clipping it — the radius is clamped to half the shorter side by Figma.
  badge.cornerRadius = o.shape === 'Circle' ? 999 : 12
  badge.paddingLeft = o.shape === 'Circle' ? 16 : 12
  badge.paddingRight = o.shape === 'Circle' ? 16 : 12
  badge.paddingTop = o.shape === 'Circle' ? 13 : 8
  badge.paddingBottom = o.shape === 'Circle' ? 13 : 9
  badge.fills = paint(COLOR.red)
  media.appendChild(badge)

  // MRP lives INSIDE the badge, struck through, directly above the price —
  // that is where every one of the reference flyers puts it. It hides itself
  // when a product has no MRP, and the badge closes up around the gap.
  const mrp = await label('#mrp', '399',
    { size: 11, weight: 'Bold', color: COLOR.white, align: 'CENTER', strike: true })
  mrp.opacity = 0.75
  badge.appendChild(mrp)

  const row = figma.createFrame()
  row.name = 'Price'
  row.layoutMode = 'HORIZONTAL'
  row.primaryAxisSizingMode = 'AUTO'
  row.counterAxisSizingMode = 'AUTO'
  // Tops aligned, not baselines: that is what makes the paise read as a
  // superscript beside the big rupee number, the way price stickers do.
  row.counterAxisAlignItems = 'MIN'
  row.itemSpacing = 1
  row.fills = []
  badge.appendChild(row)

  row.appendChild(await label('₹', '₹', { size: 11, weight: 'Bold', color: COLOR.white }))
  row.appendChild(await label('#price1', o.price === 'Whole' ? '305' : '45',
    { size: 26, weight: 'Extra Bold', color: COLOR.white }))

  // The dot and the paise exist in BOTH variants so no data can be lost by
  // picking the wrong one — they simply start hidden on the whole-rupee
  // variant. The plugin also hides #price2 by itself whenever a price has no
  // paise, so ₹305 never prints as "305.00".
  const dot = await label('.', '.', { size: 12, weight: 'Extra Bold', color: COLOR.white })
  const paise = await label('#price2', '50', { size: 14, weight: 'Extra Bold', color: COLOR.white })
  row.appendChild(dot)
  row.appendChild(paise)
  if (o.price === 'Whole') { dot.visible = false; paise.visible = false }

  badge.x = PHOTO_W - badge.width + 6
  badge.y = PHOTO_H - badge.height + 4

  /* --- name and pack size, under the photo ------------------------- */
  const info = figma.createFrame()
  info.name = 'Info'
  info.resize(PHOTO_W + 16, 40)
  info.fills = []
  info.layoutMode = 'VERTICAL'
  info.primaryAxisSizingMode = 'AUTO'
  info.counterAxisSizingMode = 'FIXED'
  info.counterAxisAlignItems = 'CENTER'
  info.itemSpacing = 0
  info.paddingTop = 10
  card.appendChild(info)

  const stack: [string, string, LabelOpts][] = [
    ['#product', 'Product Name', { size: 14, weight: 'Bold', color: COLOR.ink, align: 'CENTER', resize: 'HEIGHT' }],
    ['#weight', '100 Gm', { size: 13, weight: 'Bold', color: COLOR.ink, align: 'CENTER', resize: 'HEIGHT' }],
  ]
  for (const [name, sample, opts] of stack) {
    const node = await label(name, sample, opts)
    node.resize(PHOTO_W + 16, node.height)
    info.appendChild(node)
    node.layoutAlign = 'STRETCH'   // long names wrap instead of overflowing
  }

  return card
}

async function createCardTemplate(): Promise<void> {
  const combos: CardOpts[] = []
  for (const offer of ['Price', 'B1G1', 'Percent'] as const) {
    for (const shape of ['Circle', 'Pill'] as const) {
      for (const price of ['Whole', 'Paise'] as const) combos.push({ offer, shape, price })
    }
  }

  // Land clear of whatever is already on the page rather than on top of it.
  let right = 0, top = 0
  for (const node of figma.currentPage.children) {
    right = Math.max(right, (node.x || 0) + (node.width || 0))
    top = Math.min(top, node.y || 0)
  }
  const originX = figma.currentPage.children.length ? right + 160 : 0

  const parts: ComponentNode[] = []
  for (let i = 0; i < combos.length; i++) {
    const part = await buildCardComponent(combos[i])
    part.x = originX + (i % 4) * (CARD_W + 40)
    part.y = top + Math.floor(i / 4) * 300
    parts.push(part)
    figma.ui.postMessage({ type: 'progress', done: i + 1, total: combos.length })
  }

  const set = figma.combineAsVariants(parts, figma.currentPage)
  set.name = 'Cirqle Product Card'
  set.description =
    'Generated by Cirqle Studio. Layer names drive the data fill: #product, ' +
    '#weight, #price1, #price2, #mrp, #badges, #imageurl. Restyle freely — ' +
    'only the names matter.'
  set.x = originX
  set.y = top

  figma.currentPage.selection = [set]
  figma.viewport.scrollAndZoomIntoView([set])
  figma.ui.postMessage({ type: 'template-created', name: set.name, id: set.id, variants: parts.length })
  figma.ui.postMessage({ type: 'templates', templates: scanTemplates() })
  figma.notify('Cirqle Studio: card template created with ' + parts.length + ' variants.')
}

/* ================================================================== *
 * Message router — the single uncaught-error boundary.
 * ================================================================== */

const SETTINGS_KEY = 'cirqle-studio-settings'

figma.ui.onmessage = async (msg: any) => {
  try {
    switch (msg.type) {
      case 'ready': {
        const saved = await figma.clientStorage.getAsync(SETTINGS_KEY)
        figma.ui.postMessage({ type: 'init', settings: saved || null })
        figma.ui.postMessage({ type: 'templates', templates: scanTemplates() })
        break
      }
      case 'save-settings':
        await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings)
        break
      case 'resize':
        // The review table needs spreadsheet room; the build controls don't.
        // Sizes are clamped so the panel can never end up off-screen or
        // smaller than its own controls.
        figma.ui.resize(
          Math.max(320, Math.min(1200, Math.round(msg.width) || 380)),
          Math.max(400, Math.min(900, Math.round(msg.height) || 720)),
        )
        break
      case 'scan-templates':
        figma.ui.postMessage({ type: 'templates', templates: scanTemplates() })
        break
      case 'create-template':
        await createCardTemplate()
        break
      case 'validate-template':
        await validateTemplate(msg)
        break
      case 'build':
        await buildFlyer(msg)
        break
      case 'notify':
        figma.notify(String(msg.message || ''))
        break
      case 'close':
        figma.closePlugin()
        break
      default:
        break
    }
  } catch (err) {
    fail(
      'Unexpected plugin error.',
      'Action: ' + String(msg && msg.type),
      (err instanceof Error ? err.message : String(err)) + ' — press Refresh; if it repeats, reopen the plugin.',
    )
  }
}
