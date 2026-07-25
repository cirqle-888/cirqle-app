/**
 * Cirqle Flyer Kit — sandbox side.
 *
 * This half runs inside Figma's plugin sandbox: it can read and write the
 * document but has no DOM, no fetch, and no WebAssembly. Anything that needs
 * the network or the background-removal model happens in ui.html and comes
 * back here as bytes.
 *
 * Three jobs:
 *   1. Fill product cards from a Cirqle offer table (layer-name binding).
 *   2. Round-trip selected images through the background remover.
 *   3. Report what's selected so the UI can describe the next action.
 */

figma.showUI(__html__, { width: 420, height: 640, themeColors: true })

/* ------------------------------------------------------------------ *
 * Persistent settings + template memory
 *
 * clientStorage survives restarts, so the Cirqle URL, API secret and the
 * chosen template only have to be set once per machine — watch mode is
 * useless if arming it again every morning takes longer than pasting.
 * ------------------------------------------------------------------ */

const SETTINGS_KEY = 'cfk-settings'

// The template card watch mode rebuilds from, and the wrapper produced by
// the last build (the thing auto-export exports).
let templateId = null
let lastWrapperId = null

async function nodeById(id) {
  if (!id) return null
  // dynamic-page documents require the async lookup.
  const node = figma.getNodeByIdAsync
    ? await figma.getNodeByIdAsync(id)
    : figma.getNodeById(id)
  return node && !node.removed ? node : null
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

/**
 * Every font used by a text node must be loaded before its characters can be
 * changed — including each font in a mixed-format string, or the assignment
 * throws and the whole fill aborts halfway through a card.
 */
async function loadFontsFor(node) {
  const len = node.characters.length
  if (len > 0) {
    const fonts = node.getRangeAllFontNames(0, len)
    for (const font of fonts) await figma.loadFontAsync(font)
    return
  }
  if (node.fontName !== figma.mixed) {
    await figma.loadFontAsync(node.fontName)
    return
  }
  // An empty node with mixed fonts has no range to inspect; Inter Regular is
  // Figma's default and is always available.
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
}

/**
 * Layer names are matched case-insensitively and trimmed. Designers routinely
 * leave a trailing space or type `#Product`, and a silent miss is the worst
 * outcome here — the flyer just prints the placeholder.
 */
function normaliseName(name) {
  return String(name || '').trim().toLowerCase()
}

function findByToken(root, token) {
  const wanted = normaliseName(token)
  const hits = []
  if (normaliseName(root.name) === wanted) hits.push(root)
  if ('findAll' in root) {
    for (const node of root.findAll(n => normaliseName(n.name) === wanted)) hits.push(node)
  }
  return hits
}

/* ------------------------------------------------------------------ *
 * Image helpers
 * ------------------------------------------------------------------ */

/** Read the first image fill's bytes off a node, or null if it has none. */
async function readImageBytes(node) {
  if (!('fills' in node) || node.fills === figma.mixed) return null
  const fill = node.fills.find(f => f.type === 'IMAGE' && f.imageHash)
  if (!fill) return null
  const image = figma.getImageByHash(fill.imageHash)
  if (!image) return null
  return await image.getBytesAsync()
}

/**
 * Replace a node's image fill, keeping the scale mode the designer chose.
 * A cut-out PNG dropped into a CROP fill would re-crop to the old bounds, so
 * anything other than an explicit existing mode falls back to FILL.
 */
function setImageFill(node, bytes) {
  const image = figma.createImage(bytes)
  let scaleMode = 'FILL'
  if ('fills' in node && node.fills !== figma.mixed) {
    const existing = node.fills.find(f => f.type === 'IMAGE')
    if (existing && existing.scaleMode && existing.scaleMode !== 'CROP') {
      scaleMode = existing.scaleMode
    }
  }
  node.fills = [{ type: 'IMAGE', scaleMode: scaleMode, imageHash: image.hash }]
}

/* ------------------------------------------------------------------ *
 * Selection reporting
 * ------------------------------------------------------------------ */

function describeSelection() {
  const sel = figma.currentPage.selection
  let imageNodes = 0
  for (const node of sel) {
    const candidates = ('findAll' in node)
      ? [node].concat(node.findAll(() => true))
      : [node]
    for (const n of candidates) {
      if ('fills' in n && n.fills !== figma.mixed &&
          n.fills.some(f => f.type === 'IMAGE' && f.imageHash)) {
        imageNodes++
      }
    }
  }
  figma.ui.postMessage({
    type: 'selection',
    count: sel.length,
    names: sel.slice(0, 3).map(n => n.name),
    imageNodes: imageNodes,
  })
}

figma.on('selectionchange', describeSelection)

/* ------------------------------------------------------------------ *
 * 1. Fill product cards
 * ------------------------------------------------------------------ */

/**
 * Apply one product's fields to one card.
 *
 * An empty value hides its layer rather than printing an empty string. That
 * is the behaviour designers actually want: a product with no MRP should not
 * leave a floating strikethrough, and a product with no badge should not
 * leave an empty coloured pill.
 */
async function fillCard(card, product, opts) {
  let filled = 0
  const missing = []

  for (const token of Object.keys(product.fields)) {
    const value = product.fields[token]
    const targets = findByToken(card, token)
    if (targets.length === 0) {
      if (value) missing.push(token)
      continue
    }
    for (const node of targets) {
      if (node.type !== 'TEXT') continue
      if (!value && opts.hideEmpty) {
        node.visible = false
        continue
      }
      node.visible = true
      await loadFontsFor(node)
      node.characters = String(value)
      filled++
    }
  }

  if (product.image && product.image.length) {
    for (const node of findByToken(card, opts.imageToken)) {
      if ('fills' in node) {
        setImageFill(node, product.image)
        node.visible = true
        filled++
      }
    }
  }

  return { filled: filled, missing: missing }
}

async function applyProducts(msg) {
  let selection = figma.currentPage.selection

  // Watch mode passes useTemplate: rebuild from the remembered card even if
  // the designer has since selected something else (or nothing — the whole
  // point is that they walked away).
  if (msg.useTemplate) {
    const template = await nodeById(templateId)
    if (!template) {
      figma.ui.postMessage({ type: 'error', message: 'The saved template card no longer exists. Re-arm watch mode with a card selected.' })
      return
    }
    selection = [template]
  }

  if (selection.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Select the card template (or the cards to fill) first.' })
    return
  }

  const products = msg.products
  const opts = { hideEmpty: msg.hideEmpty !== false, imageToken: msg.imageToken || '#imageurl' }
  const report = { cards: 0, filled: 0, missing: {} }

  function noteMissing(list) {
    for (const token of list) report.missing[token] = (report.missing[token] || 0) + 1
  }

  if (selection.length > 1) {
    // Fill-in-place: the designer already laid out the cards, so respect that
    // layout exactly and only pour data in. Cards beyond the product count are
    // left untouched rather than blanked — blanking would destroy work if the
    // pasted table was short by a row.
    const pairs = Math.min(selection.length, products.length)
    for (let i = 0; i < pairs; i++) {
      const res = await fillCard(selection[i], products[i], opts)
      report.cards++
      report.filled += res.filled
      noteMissing(res.missing)
      figma.ui.postMessage({ type: 'progress', done: i + 1, total: pairs, label: 'Filling cards' })
    }
    if (products.length > selection.length) {
      report.overflow = products.length - selection.length
    }
  } else {
    // Clone mode: one template in, a grid of finished cards out.
    const template = selection[0]
    const parent = template.parent || figma.currentPage
    const cols = Math.max(1, msg.columns || 4)
    const gap = typeof msg.gap === 'number' ? msg.gap : 40

    const wrapper = figma.createFrame()
    wrapper.name = msg.title ? ('Offer — ' + msg.title) : 'Offer cards'
    wrapper.fills = []
    wrapper.clipsContent = false
    wrapper.x = template.x
    wrapper.y = template.y + template.height + gap * 2
    const rows = Math.ceil(products.length / cols)
    wrapper.resize(
      Math.max(1, cols * template.width + (cols - 1) * gap),
      Math.max(1, rows * template.height + (rows - 1) * gap)
    )
    parent.appendChild(wrapper)

    for (let i = 0; i < products.length; i++) {
      const card = template.clone()
      card.name = (products[i].fields['#product'] || ('Product ' + (i + 1)))
      wrapper.appendChild(card)
      card.x = (i % cols) * (template.width + gap)
      card.y = Math.floor(i / cols) * (template.height + gap)

      const res = await fillCard(card, products[i], opts)
      report.cards++
      report.filled += res.filled
      noteMissing(res.missing)
      figma.ui.postMessage({ type: 'progress', done: i + 1, total: products.length, label: 'Building cards' })
    }

    lastWrapperId = wrapper.id
    figma.currentPage.selection = [wrapper]
    figma.viewport.scrollAndZoomIntoView([wrapper])
  }

  figma.ui.postMessage({ type: 'apply-done', report: report })

  if (msg.autoExport) await exportBuiltFrame()
}

/* ------------------------------------------------------------------ *
 * Export — the finished flyer frame as a PNG, straight after a build.
 * ------------------------------------------------------------------ */

async function exportBuiltFrame() {
  let target = await nodeById(lastWrapperId)
  if (!target) {
    // Fill-in-place builds have no wrapper; export the selection's common
    // parent frame instead so multi-card fills still produce one image.
    const sel = figma.currentPage.selection
    target = sel.length === 1 ? sel[0] : (sel[0] && sel[0].parent && sel[0].parent.type !== 'PAGE' ? sel[0].parent : null)
  }
  if (!target || !('exportAsync' in target)) {
    figma.ui.postMessage({ type: 'error', message: 'Nothing to export yet — build cards first.' })
    return
  }
  const bytes = await target.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })
  figma.ui.postMessage({
    type: 'export-ready',
    name: (target.name || 'flyer').replace(/[^\w\- ]+/g, '').trim() || 'flyer',
    bytes: bytes,
  })
}

/* ------------------------------------------------------------------ *
 * 2. Background removal round trip
 * ------------------------------------------------------------------ */

// Nodes waiting on a cut-out, keyed by the id we handed the UI. Held here
// because the UI answers asynchronously and out of order.
const pendingBg = new Map()

async function collectForBackgroundRemoval() {
  const sel = figma.currentPage.selection
  if (sel.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Select one or more images first.' })
    return
  }

  pendingBg.clear()
  const jobs = []

  for (const node of sel) {
    const candidates = ('findAll' in node)
      ? [node].concat(node.findAll(() => true))
      : [node]
    for (const n of candidates) {
      const bytes = await readImageBytes(n)
      if (!bytes) continue
      pendingBg.set(n.id, n)
      jobs.push({ id: n.id, name: n.name, bytes: bytes })
    }
  }

  if (jobs.length === 0) {
    figma.ui.postMessage({ type: 'error', message: 'Nothing in the selection has an image fill.' })
    return
  }

  figma.ui.postMessage({ type: 'bg-jobs', jobs: jobs })
}

function applyBackgroundResult(msg) {
  const node = pendingBg.get(msg.id)
  if (!node || node.removed) return
  setImageFill(node, msg.bytes)
  pendingBg.delete(msg.id)
}

/* ------------------------------------------------------------------ *
 * 3. Place images only (no text) — useful for catalog work
 * ------------------------------------------------------------------ */

function placeImageOnSelection(msg) {
  const sel = figma.currentPage.selection
  let applied = 0
  for (const node of sel) {
    if ('fills' in node) {
      setImageFill(node, msg.bytes)
      applied++
    }
  }
  figma.ui.postMessage({ type: 'notify', message: applied
    ? ('Image placed on ' + applied + ' layer' + (applied === 1 ? '' : 's') + '.')
    : 'Select a shape or frame that can take an image fill.' })
}

/* ------------------------------------------------------------------ *
 * Message router
 * ------------------------------------------------------------------ */

figma.ui.onmessage = async (msg) => {
  try {
    switch (msg.type) {
      case 'ready': {
        describeSelection()
        const saved = await figma.clientStorage.getAsync(SETTINGS_KEY)
        if (saved) figma.ui.postMessage({ type: 'settings', settings: saved })
        break
      }
      case 'save-settings':
        await figma.clientStorage.setAsync(SETTINGS_KEY, msg.settings)
        break
      case 'capture-template': {
        const sel = figma.currentPage.selection
        if (sel.length !== 1) {
          figma.ui.postMessage({ type: 'template-captured', ok: false, message: 'Select exactly one card to use as the template.' })
        } else {
          templateId = sel[0].id
          figma.ui.postMessage({ type: 'template-captured', ok: true, name: sel[0].name })
        }
        break
      }
      case 'export-frame':
        await exportBuiltFrame()
        break
      case 'apply-products':
        await applyProducts(msg)
        break
      case 'bg-collect':
        await collectForBackgroundRemoval()
        break
      case 'bg-result':
        applyBackgroundResult(msg)
        break
      case 'bg-finished':
        figma.notify('Background removed on ' + msg.count + ' image' + (msg.count === 1 ? '' : 's') + '.')
        break
      case 'place-image':
        placeImageOnSelection(msg)
        break
      case 'notify':
        figma.notify(msg.message)
        break
      case 'close':
        figma.closePlugin()
        break
    }
  } catch (err) {
    // Surface the real reason in the panel — a silent failure here reads as
    // "the plugin did nothing" and costs far more time to diagnose.
    figma.ui.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) })
  }
}
